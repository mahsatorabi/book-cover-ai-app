const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/api/scan" && request.method === "POST") {
      return withCors(await handleScan(request, env));
    }

    if (url.pathname.startsWith("/covers/") && request.method === "GET") {
      return withCors(await getCover(url.pathname, env));
    }

    if (url.pathname === "/api/books" && request.method === "POST") {
      return withCors(await createBook(request, env));
    }

    if (url.pathname.startsWith("/api/books/") && request.method === "PUT") {
      return withCors(await updateBook(request, env, url.pathname));
    }

    if (url.pathname.startsWith("/api/books/") && request.method === "DELETE") {
      return withCors(await deleteBook(env, url.pathname));
    }

    if (url.pathname === "/api/books" && request.method === "GET") {
      return withCors(await listBooks(env));
    }

    if (url.pathname === "/api/export.csv" && request.method === "GET") {
      return withCors(await exportCsv(env));
    }

    return withCors(json({ error: "Not found" }, 404));
  }
};

async function handleScan(request, env) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return json({ error: "multipart/form-data required" }, 400);
    }

    const formData = await request.formData();
    const file = formData.get("image");
    if (!file || !(file instanceof File)) {
      return json({ error: "image file is required" }, 400);
    }

    const bytes = await file.arrayBuffer();
    const mime = file.type || "image/jpeg";
    let coverUrl = "";
    let coverKey = "";

    if (env.BOOK_COVERS) {
      try {
        coverKey = `${Date.now()}-${safeName(file.name || "cover.jpg")}`;
        await env.BOOK_COVERS.put(coverKey, bytes, {
          httpMetadata: { contentType: mime }
        });
        coverUrl = `/covers/${coverKey}`;
      } catch {
        coverUrl = toDataUrl(bytes, mime);
      }
    } else {
      coverUrl = toDataUrl(bytes, mime);
    }

    const { raw, parsed, models } = await extractBookInfo(env, bytes, mime);

    return json({
      coverKey,
      coverUrl,
      extractedText: raw,
      parsed,
      models
    });
  } catch (error) {
    return json({ error: error.message || "scan failed" }, 500);
  }
}

async function createBook(request, env) {
  try {
    const data = await request.json();
    const title = `${data.title || ""}`.trim();
    if (!title) {
      return json({ error: "title is required" }, 400);
    }

    const stmt = env.DB.prepare(
      `INSERT INTO books (
        title, subtitle, creators, authors, translators, editors, illustrators, compilers,
        isbn, publisher, publication_place, publish_year, print_year, edition, volume,
        series_title, language, category, subjects, tags, call_number, cover_text, notes, cover_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      title,
      data.subtitle || "",
      data.creators || "",
      data.authors || "",
      data.translators || "",
      data.editors || "",
      data.illustrators || "",
      data.compilers || "",
      data.isbn || "",
      data.publisher || "",
      data.publication_place || "",
      data.publish_year || "",
      data.print_year || "",
      data.edition || "",
      data.volume || "",
      data.series_title || "",
      data.language || "",
      data.category || "",
      data.subjects || "",
      data.tags || "",
      data.call_number || "",
      data.cover_text || "",
      data.notes || "",
      data.cover_url || ""
    );

    const result = await stmt.run();
    return json({ ok: true, id: result.meta.last_row_id });
  } catch (error) {
    return json({ error: error.message || "save failed" }, 500);
  }
}

async function updateBook(request, env, pathname) {
  try {
    const id = Number(pathname.replace("/api/books/", ""));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid id" }, 400);
    const data = await request.json();
    const title = `${data.title || ""}`.trim();
    if (!title) return json({ error: "title is required" }, 400);

    const result = await env.DB.prepare(
      `UPDATE books
       SET title=?, subtitle=?, creators=?, authors=?, translators=?, editors=?, illustrators=?, compilers=?,
           isbn=?, publisher=?, publication_place=?, publish_year=?, print_year=?, edition=?, volume=?,
           series_title=?, language=?, category=?, subjects=?, tags=?, call_number=?, cover_text=?, notes=?, cover_url=?
       WHERE id=?`
    )
      .bind(
        title,
        data.subtitle || "",
        data.creators || "",
        data.authors || "",
        data.translators || "",
        data.editors || "",
        data.illustrators || "",
        data.compilers || "",
        data.isbn || "",
        data.publisher || "",
        data.publication_place || "",
        data.publish_year || "",
        data.print_year || "",
        data.edition || "",
        data.volume || "",
        data.series_title || "",
        data.language || "",
        data.category || "",
        data.subjects || "",
        data.tags || "",
        data.call_number || "",
        data.cover_text || "",
        data.notes || "",
        data.cover_url || "",
        id
      )
      .run();

    if ((result.meta?.changes || 0) === 0) return json({ error: "book not found" }, 404);
    return json({ ok: true, id });
  } catch (error) {
    return json({ error: error.message || "update failed" }, 500);
  }
}

async function deleteBook(env, pathname) {
  try {
    const id = Number(pathname.replace("/api/books/", ""));
    if (!Number.isInteger(id) || id <= 0) return json({ error: "invalid id" }, 400);
    const result = await env.DB.prepare(`DELETE FROM books WHERE id=?`).bind(id).run();
    if ((result.meta?.changes || 0) === 0) return json({ error: "book not found" }, 404);
    return json({ ok: true, id });
  } catch (error) {
    return json({ error: error.message || "delete failed" }, 500);
  }
}

async function getCover(pathname, env) {
  if (!env.BOOK_COVERS) return json({ error: "cover storage not configured" }, 503);
  const key = pathname.replace("/covers/", "");
  if (!key) return json({ error: "invalid cover key" }, 400);
  const obj = await env.BOOK_COVERS.get(key);
  if (!obj) return json({ error: "cover not found" }, 404);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600"
    }
  });
}

async function listBooks(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, subtitle, creators, authors, translators, editors, illustrators, compilers,
            isbn, publisher, publication_place, publish_year, print_year, edition, volume,
            series_title, language, category, subjects, tags, call_number, cover_text,
            notes, cover_url, created_at
     FROM books
     ORDER BY id DESC`
  ).all();
  return json({ items: results || [] });
}

async function exportCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, subtitle, creators, authors, translators, editors, illustrators, compilers,
            isbn, publisher, publication_place, publish_year, print_year, edition, volume,
            series_title, language, category, subjects, tags, call_number, cover_text,
            notes, cover_url, created_at
     FROM books
     ORDER BY id DESC`
  ).all();

  const headers = [
    "id",
    "title",
    "subtitle",
    "creators",
    "authors",
    "translators",
    "editors",
    "illustrators",
    "compilers",
    "isbn",
    "publisher",
    "publication_place",
    "publish_year",
    "print_year",
    "edition",
    "volume",
    "series_title",
    "language",
    "category",
    "subjects",
    "tags",
    "call_number",
    "cover_text",
    "notes",
    "cover_url",
    "created_at"
  ];
  const rows = [headers.join(",")];
  for (const row of results || []) {
    const line = headers.map((h) => csvEscape(row[h])).join(",");
    rows.push(line);
  }

  const csvContent = `\uFEFF${rows.join("\n")}`;
  return new Response(csvContent, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=books.csv"
    }
  });
}

const PRIMARY_VISION_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MODEL_TIMEOUT_MS = 28000;

function getVisionModels(env) {
  return [
    {
      id: PRIMARY_VISION_MODEL,
      run: (prompt, dataUrl) =>
        env.AI.run(PRIMARY_VISION_MODEL, {
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: `${prompt.system}\n\n${prompt.user}` }
              ]
            }
          ],
          max_tokens: 700
        })
    },
    {
      id: "@cf/meta/llama-3.2-11b-vision-instruct",
      run: (prompt, dataUrl) =>
        env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          image: dataUrl,
          max_tokens: 500
        })
    },
    {
      id: "@cf/meta/llama-4-scout-17b-16e-instruct",
      run: (prompt, dataUrl) =>
        env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                { type: "text", text: `${prompt.system}\n\n${prompt.user}` }
              ]
            }
          ],
          max_tokens: 500
        })
    }
  ];
}

function getStructuringModels(env, preferredModelId = "") {
  const models = [
    {
      id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
      run: (prompt) =>
        env.AI.run("@cf/mistralai/mistral-small-3.1-24b-instruct", {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          max_tokens: 450
        })
    },
    {
      id: "@cf/meta/llama-3.2-11b-vision-instruct",
      run: (prompt) =>
        env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          max_tokens: 450
        })
    },
    {
      id: PRIMARY_VISION_MODEL,
      run: (prompt) =>
        env.AI.run(PRIMARY_VISION_MODEL, {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          max_tokens: 500
        })
    },
    {
      id: "@cf/meta/llama-4-scout-17b-16e-instruct",
      run: (prompt) =>
        env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: `${prompt.system}\n\n${prompt.user}` }]
            }
          ],
          max_tokens: 450
        })
    }
  ];

  if (!preferredModelId) return models;
  const preferred = models.find((model) => model.id === preferredModelId);
  if (!preferred) return models;
  return [preferred, ...models.filter((model) => model.id !== preferredModelId)];
}

async function extractBookInfo(env, imageBytes, mime) {
  const startedAt = Date.now();
  const dataUrl = toDataUrl(imageBytes, mime);
  const stage1 = await extractVisibleLines(env, dataUrl);
  const stage1CatalogLines = extractCatalogLines(stage1.raw, stage1.lines);
  const stage1Parsed = parsePersianCipRecord(stage1CatalogLines);
  const hasGoodCip = Boolean(
    stage1Parsed.title && (stage1Parsed.main_entry || stage1Parsed.isbn || stage1Parsed.publisher)
  );
  const structuredPrompt = buildStructuredPrompt(stage1CatalogLines);

  let structuredText = null;
  let stage2Model = null;
  let stage2Attempts = [];
  let lastError = null;
  const stage2StartedAt = Date.now();

  if (!hasGoodCip) {
    for (const model of getStructuringModels(env)) {
      const attemptStartedAt = Date.now();
      try {
        const result = await runModelAttempt(env, model.id, () => model.run(structuredPrompt));
        structuredText = extractModelText(result);
        const durationMs = Date.now() - attemptStartedAt;
        stage2Attempts.push({
          model: model.id,
          ok: Boolean(structuredText?.trim()),
          duration_ms: durationMs
        });
        if (structuredText?.trim()) {
          stage2Model = model.id;
          break;
        }
      } catch (error) {
        stage2Attempts.push({
          model: model.id,
          ok: false,
          duration_ms: Date.now() - attemptStartedAt,
          error: `${error?.message || error}`
        });
        lastError = error;
      }
    }
  }

  if (!structuredText?.trim()) {
    structuredText = stage1.raw || stage1CatalogLines.join("\n");
  }

  if (!hasGoodCip && !stage1CatalogLines.length && !structuredText?.trim()) {
    throw lastError || new Error("مدل هوش مصنوعی پاسخی برنگرداند");
  }

  const stage2Ms = Date.now() - stage2StartedAt;
  const totalMs = Date.now() - startedAt;
  const combinedParseText = [structuredText, stage1.raw].filter(Boolean).join("\n\n");

  const combinedRaw = JSON.stringify(
    {
      stage1_model: stage1.model,
      stage1_duration_ms: stage1.durationMs,
      stage1_attempts: stage1.attempts,
      stage1_visible_lines: stage1CatalogLines,
      stage1_raw: stage1.raw,
      stage2_model: stage2Model,
      stage2_skipped: hasGoodCip,
      stage2_duration_ms: stage2Ms,
      stage2_attempts: stage2Attempts,
      stage2_structured: safeJsonParse(structuredText) || structuredText,
      total_duration_ms: totalMs
    },
    null,
    2
  );

  return {
    raw: combinedRaw,
    parsed: parseBookJson(combinedParseText, stage1CatalogLines),
    models: {
      stage1: stage1.model,
      stage2: stage2Model,
      stage1_ms: stage1.durationMs,
      stage2_ms: stage2Ms,
      total_ms: totalMs,
      stage1_attempts: stage1.attempts,
      stage2_attempts: stage2Attempts
    }
  };
}

async function extractVisibleLines(env, dataUrl) {
  const linesPrompt = buildCoverLinesPrompt();
  let lastError = null;
  const startedAt = Date.now();
  const attempts = [];

  for (const model of getVisionModels(env)) {
    const attemptStartedAt = Date.now();
    try {
      const result = await runModelAttempt(env, model.id, () => model.run(linesPrompt, dataUrl));
      const text = extractModelText(result);
      const lines = parseVisibleTextLines(text);
      const durationMs = Date.now() - attemptStartedAt;
      attempts.push({
        model: model.id,
        ok: lines.length > 0,
        duration_ms: durationMs,
        lines_count: lines.length
      });
      if (lines.length) {
        return {
          lines,
          raw: text,
          model: model.id,
          durationMs: Date.now() - startedAt,
          attempts
        };
      }
    } catch (error) {
      attempts.push({
        model: model.id,
        ok: false,
        duration_ms: Date.now() - attemptStartedAt,
        error: `${error?.message || error}`
      });
      lastError = error;
    }
  }

  throw lastError || new Error("خواندن صفحات حقوقی انجام نشد");
}

async function runModelAttempt(env, modelId, runFn) {
  return runWithLicense(env, modelId, () => runWithTimeout(runFn(), MODEL_TIMEOUT_MS, modelId));
}

async function runWithTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`مدل ${shortModelLabel(label)} بیش از حد طول کشید`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shortModelLabel(modelId) {
  if (!modelId) return "نامشخص";
  if (modelId.includes("gemma-4")) return "Gemma 4";
  if (modelId.includes("mistral-small")) return "Mistral Small 3.1";
  if (modelId.includes("llama-4-scout")) return "Llama 4 Scout";
  if (modelId.includes("llama-3.2")) return "Llama 3.2 Vision";
  return modelId.split("/").pop() || modelId;
}

async function runWithLicense(env, modelId, runFn) {
  try {
    return await runFn();
  } catch (error) {
    const msg = `${error?.message || error}`;
    if (modelId.includes("llama-3.2") && /license|agree/i.test(msg)) {
      await env.AI.run(modelId, { prompt: "agree" });
      return await runFn();
    }
    throw error;
  }
}

function extractModelText(result) {
  if (typeof result === "string") return normalizeModelText(result);
  if (typeof result?.answer === "string") return normalizeModelText(result.answer);
  if (typeof result?.caption === "string") return normalizeModelText(result.caption);
  if (Array.isArray(result?.choices)) {
    const msg = result.choices[0]?.message;
    if (msg) {
      if (typeof msg.content === "string" && msg.content.trim()) {
        return normalizeModelText(msg.content);
      }
      if (Array.isArray(msg.content)) {
        const joined = msg.content
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (joined.trim()) return normalizeModelText(joined);
      }
      if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
        return normalizeModelText(msg.reasoning);
      }
    }
  }
  if (typeof result?.response === "string") return normalizeModelText(result.response);
  if (typeof result?.result?.response === "string") return normalizeModelText(result.result.response);
  return "";
}

function normalizeModelText(text) {
  const value = `${text || ""}`.trim();
  if (!value || isGarbageField(value)) return "";
  return value;
}

function isGarbageField(value) {
  const text = `${value || ""}`;
  return (
    /"choices"\s*:\s*\[/.test(text) ||
    /chat\.completion/.test(text) ||
    /finish_reason/.test(text) ||
    /prompt_tokens/.test(text) ||
    /"role"\s*:\s*"assistant"/.test(text) ||
    /^\s*\{[\s\S]*"model"\s*:/.test(text)
  );
}

const SCHEMA_FIELD_NAMES = new Set([
  "main_entry",
  "title",
  "subtitle",
  "parallel_title",
  "creators",
  "authors",
  "translators",
  "editors",
  "illustrators",
  "compilers",
  "edition",
  "publication_place",
  "publisher",
  "publish_year",
  "copyright_date",
  "print_year",
  "extent",
  "dimensions",
  "accompanying_material",
  "volume_number",
  "series_title",
  "series_number",
  "added_entries",
  "language",
  "subjects",
  "call_number",
  "cover_text",
  "notes",
  "visible_text_lines",
  "confidence_notes",
  "statement_of_responsibility"
]);

function isPlaceholderValue(value) {
  const text = cleanField(value);
  if (!text) return true;
  const lower = text.toLowerCase();

  if (text.length <= 2 && !/[۰-۹0-9]{2}/.test(text) && !/^(fa|en)$/i.test(lower)) return true;
  if (/^(fa\|en\|unknown|fa|en|unknown|\.\.\.)$/i.test(lower)) return true;
  if (SCHEMA_FIELD_NAMES.has(lower)) return true;
  if (/^_[a-z_]+$/i.test(text)) return true;
  if (/_title|_number|_material/i.test(text)) return true;
  if (/follow aacr2|aacr2 principles|only extract|do not guess|valid json/i.test(lower)) {
    return true;
  }
  if (/^مثلاً\s/.test(text)) return true;
  if (/^مترجم،\s*ویراستار/.test(text)) return true;
  if (/^\.\s/.test(text)) return true;
  if (/\|\s*[a-z]$/i.test(text)) return true;

  return false;
}

function isValidLanguageCode(value) {
  const code = cleanField(value).toLowerCase();
  return code === "fa" || code === "en" || code === "unknown";
}

function stripFieldNoise(value) {
  return cleanField(value)
    .replace(/\s*\|\s*[a-z]\s*$/i, "")
    .replace(/\s*\|\s*$/g, "")
    .trim();
}

function sanitizeFieldValue(value, maxLen = 220) {
  let text = stripFieldNoise(value);
  if (!text || isGarbageField(text) || isPlaceholderValue(text)) return "";
  text = text
    .split(/\n|\*|"refusal"|"\s*,\s*"role"|"\s*,\s*"tool_calls"/)[0]
    .replace(/\s{2,}/g, " ")
    .replace(/^\*+\s*/, "")
    .trim();
  text = text.replace(/[.;،]\s*$/, "").trim();
  if (isPlaceholderValue(text)) return "";
  if (text.length > maxLen) text = text.slice(0, maxLen).trim();
  return text;
}

function sanitizeBookRecord(book) {
  const limits = {
    main_entry: 120,
    title: 180,
    subtitle: 180,
    parallel_title: 180,
    creators: 220,
    authors: 120,
    translators: 120,
    editors: 120,
    illustrators: 120,
    compilers: 120,
    edition: 80,
    publication_place: 80,
    publisher: 120,
    publish_year: 10,
    copyright_date: 10,
    print_year: 10,
    extent: 80,
    dimensions: 80,
    accompanying_material: 120,
    volume_number: 40,
    series_title: 160,
    series_number: 40,
    added_entries: 180,
    isbn: 30,
    language: 20,
    subjects: 220,
    call_number: 80,
    cover_text: 1200,
    notes: 300
  };
  const out = {};
  for (const key of AACR2_BOOK_FIELDS) {
    let value = sanitizeFieldValue(book[key], limits[key] || 220);
    if (key === "language" && value && !isValidLanguageCode(value)) {
      value = "";
    }
    out[key] = value;
  }
  normalizePublicationFields(out);
  return out;
}

const AACR2_BOOK_FIELDS = [
  "main_entry",
  "title",
  "subtitle",
  "parallel_title",
  "creators",
  "authors",
  "translators",
  "editors",
  "illustrators",
  "compilers",
  "edition",
  "publication_place",
  "publisher",
  "publish_year",
  "copyright_date",
  "print_year",
  "extent",
  "dimensions",
  "accompanying_material",
  "volume_number",
  "series_title",
  "series_number",
  "added_entries",
  "isbn",
  "language",
  "subjects",
  "call_number",
  "cover_text",
  "notes"
];

const AACR2_STRUCTURED_JSON = `{"main_entry":"","title":"","subtitle":"","parallel_title":"","creators":"","authors":"","translators":"","editors":"","illustrators":"","compilers":"","edition":"","publication_place":"","publisher":"","publish_year":"","copyright_date":"","print_year":"","extent":"","dimensions":"","accompanying_material":"","volume_number":"","series_title":"","series_number":"","added_entries":"","language":"fa","isbn":"","subjects":"","call_number":"","cover_text":"","notes":""}`;

function parseBookJson(text, visibleLines = []) {
  const catalogLines = extractCatalogLines(text, visibleLines);
  const cipParsed = parsePersianCipRecord(catalogLines);
  const payload = extractStructuredPayload(text);
  const fromStructured = mapPayloadToBook(payload);
  const fromLines = inferFieldsFromVisibleLines(catalogLines);
  const merged = mergeBookFields(
    cipParsed,
    mergeBookFields(fromStructured, fromLines)
  );

  if (!merged.cover_text) {
    merged.cover_text = catalogLines.slice(0, 12).join("\n");
  }
  if (!merged.isbn) {
    merged.isbn = findIsbn([text, catalogLines.join("\n")].join("\n"));
  }

  merged.notes = sanitizeFieldValue(payload.confidence_notes, 300) || "";

  return sanitizeBookRecord(merged);
}

function extractStructuredPayload(text) {
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") return {};
  if (parsed.response && typeof parsed.response === "object") return parsed.response;
  if (parsed.stage2_structured && typeof parsed.stage2_structured === "object") {
    return parsed.stage2_structured;
  }
  const keys = Object.keys(parsed);
  if (
    keys.length > 0 &&
    keys.every((key) => ["language", "visible_text_lines", "confidence_notes"].includes(key))
  ) {
    return {};
  }
  return parsed;
}

function mapPayloadToBook(payload) {
  const normalized = normalizeBookPayload(payload);
  const book = {};
  for (const key of AACR2_BOOK_FIELDS) {
    book[key] = sanitizeFieldValue(normalized[key]);
  }
  if (!book.main_entry) book.main_entry = sanitizeFieldValue(normalized.authors);
  if (!book.extent) book.extent = sanitizeFieldValue(normalized.volume);
  if (!book.creators) {
    book.creators = sanitizeFieldValue(normalized.statement_of_responsibility);
  }
  return book;
}

function mergeBookFields(primary, fallback) {
  const merged = {};
  for (const key of AACR2_BOOK_FIELDS) {
    merged[key] =
      sanitizeFieldValue(primary[key]) || sanitizeFieldValue(fallback[key]) || "";
  }
  return merged;
}

function extractCatalogLines(text, visibleLines = []) {
  const lines = [];
  for (const line of visibleLines || []) {
    const cleaned = cleanCatalogLine(line);
    if (cleaned) lines.push(cleaned);
  }
  const raw = `${text || ""}`;
  const parsed = safeJsonParse(raw);
  if (parsed && Array.isArray(parsed.visible_text_lines)) {
    for (const line of parsed.visible_text_lines) {
      const cleaned = cleanCatalogLine(line);
      if (cleaned) lines.push(cleaned);
    }
  }
  for (const match of raw.matchAll(/(?:^|\n)\s*[*•-]\s*(.+?)(?=\n|$)/g)) {
    const cleaned = cleanCatalogLine(match[1]);
    if (cleaned) lines.push(cleaned);
  }
  for (const match of raw.matchAll(
    /(سرشناسه|عنوان و نام پدیدآور|عنوان|گردآورنده|مشخصات نشر|مشخصات ظاهری|موضوع|شناسه افزوده|رده بندی کنگره|رده بندی دیویی|شماره کتابشناسی ملی|شابک|ISBN|نوبت چاپ|ویراستار|مترجم|مدیر مسئول نشر|ناشر|تهران)\s*[:：]?\s*(.+?)(?=\n|$)/gi
  )) {
    const label = match[1];
    const value = match[2];
    const cleaned = cleanCatalogLine(
      label === "تهران" ? `مشخصات نشر: ${label}: ${value}` : `${label}: ${value}`
    );
    if (cleaned) lines.push(cleaned);
  }
  return [...new Set(lines)].filter(looksLikeCatalogLine);
}

function looksLikeCatalogLine(line) {
  const text = cleanField(line);
  if (!text || isGarbageField(text) || isPlaceholderValue(text)) return false;
  if (/[\u0600-\u06FF]/.test(text)) return true;
  return /^(سرشناسه|عنوان|ISBN|شابک|موضوع|نوبت چاپ)/i.test(text);
}

function normalizePublicationFields(book) {
  if (book.publication_place && /[:：]/.test(book.publication_place)) {
    const pubMatch = book.publication_place.match(
      /^(.+?)[:：]\s*(?:نشر\s*)?(.+?)(?:[،,]\s*([۰-۹0-9]{4}))?.*$/
    );
    if (pubMatch) {
      book.publication_place = sanitizeFieldValue(pubMatch[1]);
      if (!book.publisher) {
        book.publisher = sanitizeFieldValue(pubMatch[2].replace(/^نشر\s*/, ""));
      }
      if (!book.publish_year && pubMatch[3]) {
        book.publish_year = toEnglishDigits(pubMatch[3]);
      }
    }
  }

  if (book.publisher) {
    let publisher = book.publisher;
    if (publisher.includes("|")) {
      const parts = publisher.split("|").map((part) => part.trim()).filter(Boolean);
      publisher =
        parts.find((part) => /(متخصصان|انتشارات|نشر|موسسه|مؤسسه)/.test(part)) ||
        parts[parts.length - 1];
    }
    publisher = publisher
      .replace(/^نشر\s*/, "")
      .replace(/[،,]\s*[۰-۹0-9]{4}.*$/, "")
      .trim();
    if (!/(متخصصان|انتشارات|نشر|موسسه|مؤسسه)/.test(publisher) && book.publication_place) {
      publisher = "";
    }
    book.publisher = sanitizeFieldValue(publisher);
  }

  if (book.publisher && /خضرا|مدیر مسئول/i.test(book.publisher)) {
    book.publisher = "";
  }
}

function cleanCatalogLine(line) {
  let text = sanitizeFieldValue(line, 260);
  if (!text) return "";
  text = text.replace(/^\*+\s*/, "").replace(/\.\s*$/, "").trim();
  if (isGarbageField(text)) return "";
  if (/^(Top Section|Middle Section|Bottom Section|Language|Text lines extraction)/i.test(text)) {
    return "";
  }
  return text;
}

function parsePersianCipRecord(lines = []) {
  const result = {};
  const allText = lines.join("\n");

  for (const line of lines) {
    const mainEntry = pickLabeledValue(line, ["سرشناسه"]);
    if (mainEntry) result.main_entry = mainEntry;

    const titleLine = pickLabeledValue(line, ["عنوان و نام پدیدآور", "عنوان"]);
    if (titleLine) {
      const colonParts = titleLine.split(/[:：]/).map((part) => part.trim()).filter(Boolean);
      if (colonParts.length >= 2) {
        result.title = colonParts[0];
        result.subtitle = colonParts.slice(1).join(" - ");
      } else {
        result.title = titleLine;
      }
    }

    const compilerLine = pickLabeledValue(line, ["گردآورنده"]);
    if (compilerLine) {
      const segments = compilerLine.split(/[؛;]/).map((part) => part.trim()).filter(Boolean);
      if (segments[0]) {
        result.compilers = pickLabeledValue(segments[0], ["گردآورنده"]) || segments[0];
      }
      for (const segment of segments) {
        const editor = pickLabeledValue(segment, ["ویراستار"]);
        if (editor) result.editors = editor;
      }
    }

    const editorOnly = pickLabeledValue(line, ["ویراستار"]);
    if (editorOnly && !result.editors) result.editors = editorOnly;

    const pubSpec = pickLabeledValue(line, ["مشخصات نشر"]);
    if (pubSpec) {
      const pubMatch = pubSpec.match(/^(.+?)[:：]\s*(.+?)[،,]\s*([۰-۹0-9]{4})/);
      if (pubMatch) {
        result.publication_place = pubMatch[1].trim();
        result.publisher = pubMatch[2].trim();
        result.publish_year = toEnglishDigits(pubMatch[3]);
      }
    }

    const extent = pickLabeledValue(line, ["مشخصات ظاهری", "تعداد صفحات"]);
    if (extent) {
      const parts = extent.split(/[:：]/).map((part) => part.trim()).filter(Boolean);
      result.extent = parts[0] || extent;
      if (parts[1]) result.dimensions = parts[1];
    }

    const subject = pickLabeledValue(line, ["موضوع"]);
    if (subject) result.subjects = appendUnique(result.subjects, subject);

    const added = pickLabeledValue(line, ["شناسه افزوده", "سرشناسه افزوده"]);
    if (added) result.added_entries = added;

    const congress = pickLabeledValue(line, ["رده بندی کنگره", "رده‌بندی کنگره"]);
    const dewey = pickLabeledValue(line, ["رده بندی دیویی", "رده‌بندی دیویی"]);
    if (congress || dewey) {
      result.call_number = [congress, dewey].filter(Boolean).join(" / ");
    }

    const edition = pickLabeledValue(line, ["نوبت چاپ"]);
    if (edition) result.edition = edition;

    const isbnLine = pickLabeledValue(line, ["شابک", "ISBN"]);
    if (isbnLine) result.isbn = findIsbn(isbnLine) || isbnLine;
  }

  if (!result.isbn) result.isbn = findIsbn(allText);
  if (!result.authors && result.main_entry) result.authors = result.main_entry;
  if (!result.language && /[\u0600-\u06FF]/.test(allText)) result.language = "fa";

  const creatorParts = [];
  if (result.compilers) creatorParts.push(`گردآورنده: ${result.compilers}`);
  if (result.editors) creatorParts.push(`ویراستار: ${result.editors}`);
  if (result.authors) creatorParts.push(`نویسنده: ${result.authors}`);
  if (result.translators) creatorParts.push(`مترجم: ${result.translators}`);
  if (creatorParts.length) result.creators = creatorParts.join("؛ ");

  return sanitizeBookRecord(result);
}

function inferFieldsFromVisibleLines(lines = []) {
  const result = {};
  const contentLines = [];

  for (const rawLine of lines) {
    const line = cleanField(rawLine);
    if (!line) continue;

    const mainEntry = pickLabeledValue(line, ["سرشناسه", "main entry", "heading"]);
    if (mainEntry) result.main_entry = appendUnique(result.main_entry, mainEntry);

    const parallelTitle = pickLabeledValue(line, ["عنوان برابر", "parallel title"]);
    if (parallelTitle) result.parallel_title = appendUnique(result.parallel_title, parallelTitle);

    const addedEntries = pickLabeledValue(line, ["سرشناسه افزوده", "added entry"]);
    if (addedEntries) result.added_entries = appendUnique(result.added_entries, addedEntries);

    const author = pickLabeledValue(line, [
      "نویسنده",
      "نگارنده",
      "تألیف",
      "تالیف",
      "author",
      "by"
    ]);
    if (author) result.authors = appendUnique(result.authors, author);

    const translator = pickLabeledValue(line, ["مترجم", "ترجمه", "translator"]);
    if (translator) result.translators = appendUnique(result.translators, translator);

    const editor = pickLabeledValue(line, ["ویراستار", "ویرایش", "editor"]);
    if (editor) result.editors = appendUnique(result.editors, editor);

    const illustrator = pickLabeledValue(line, ["تصویرگر", "تصویر", "illustrator"]);
    if (illustrator) result.illustrators = appendUnique(result.illustrators, illustrator);

    const compiler = pickLabeledValue(line, ["گردآورنده", "گردآوری", "compiler"]);
    if (compiler) result.compilers = appendUnique(result.compilers, compiler);

    const publisher = pickLabeledValue(line, ["ناشر", "انتشارات", "نشر", "publisher"]);
    if (publisher) result.publisher = appendUnique(result.publisher, publisher);

    const place = pickLabeledValue(line, ["محل نشر", "مکان نشر", "place"]);
    if (place) result.publication_place = appendUnique(result.publication_place, place);

    const publishYear = pickLabeledValue(line, ["سال انتشار", "سال", "year", "publish year"]);
    if (publishYear) result.publish_year = normalizeYear(publishYear) || result.publish_year;

    const printYear = pickLabeledValue(line, ["سال چاپ", "print year"]);
    if (printYear) result.print_year = normalizeYear(printYear) || result.print_year;

    const copyrightDate = pickLabeledValue(line, ["سال حقوق", "حقوق نشر", "copyright"]);
    if (copyrightDate) result.copyright_date = normalizeYear(copyrightDate) || result.copyright_date;

    const extent = pickLabeledValue(line, ["تعداد صفحات", "صفحات", "مشخصات ظاهری", "extent", "pages"]);
    if (extent) result.extent = appendUnique(result.extent, extent);

    const dimensions = pickLabeledValue(line, ["ابعاد", "dimensions"]);
    if (dimensions) result.dimensions = appendUnique(result.dimensions, dimensions);

    const accompanying = pickLabeledValue(line, ["مواد همراه", "accompanying"]);
    if (accompanying) result.accompanying_material = appendUnique(result.accompanying_material, accompanying);

    const volumeNumber = pickLabeledValue(line, ["شماره جلد", "volume number"]);
    if (volumeNumber) result.volume_number = appendUnique(result.volume_number, volumeNumber);

    const seriesNumber = pickLabeledValue(line, ["شماره فروست", "series number"]);
    if (seriesNumber) result.series_number = appendUnique(result.series_number, seriesNumber);

    const edition = pickLabeledValue(line, ["نوبت چاپ", "ویرایش", "edition"]);
    if (edition && !result.edition) result.edition = edition;

    const series = pickLabeledValue(line, ["فروست", "مجموعه", "سری", "series"]);
    if (series) result.series_title = appendUnique(result.series_title, series);

    const subject = pickLabeledValue(line, ["موضوع", "subject"]);
    if (subject) result.subjects = appendUnique(result.subjects, subject);

    const category = pickLabeledValue(line, ["دسته", "رده موضوعی", "category"]);
    if (category) result.category = appendUnique(result.category, category);

    const callNumber = pickLabeledValue(line, ["رده", "شماره بازیابی", "call number"]);
    if (callNumber) result.call_number = appendUnique(result.call_number, callNumber);

    const isbn = findIsbn(line);
    if (isbn) result.isbn = isbn;

    if (!isMetadataLine(line)) {
      contentLines.push(line);
    }
  }

  if (!result.title && contentLines.length) {
    result.title = contentLines[0];
  }
  if (!result.subtitle && contentLines.length > 1 && !isMetadataLine(contentLines[1])) {
    const second = contentLines[1];
    if (!result.authors && looksLikePersonName(second)) {
      result.authors = second;
    } else {
      result.subtitle = second;
    }
  }

  for (const line of contentLines.slice(1)) {
    if (!result.publisher && /(انتشارات|نشر|پخش|موسسه|مؤسسه)/.test(line)) {
      result.publisher = line
        .replace(/^(انتشارات|نشر|پخش|موسسه|مؤسسه)\s*[:：]?\s*/i, "")
        .trim() || line;
    }
    if (!result.authors && looksLikePersonName(line)) {
      result.authors = line;
    }
  }

  if (!result.main_entry && result.authors) result.main_entry = result.authors;

  const creatorParts = [];
  if (result.authors) creatorParts.push(`نویسنده: ${result.authors}`);
  if (result.translators) creatorParts.push(`مترجم: ${result.translators}`);
  if (result.editors) creatorParts.push(`ویراستار: ${result.editors}`);
  if (result.illustrators) creatorParts.push(`تصویرگر: ${result.illustrators}`);
  if (result.compilers) creatorParts.push(`گردآورنده: ${result.compilers}`);
  if (creatorParts.length) result.creators = creatorParts.join(" | ");

  if (!result.publication_place) {
    const placeLine = lines.find((line) =>
      /(تهران|مشهد|اصفهان|شیراز|تبریز|قم|کرج|اهواز|رشت|یزد|همدان|ارومیه|کرمان|zahedan|tehran)/i.test(
        line
      )
    );
    if (placeLine) result.publication_place = cleanField(placeLine);
  }

  if (!result.publish_year) {
    for (const line of lines) {
      const pubSpec = pickLabeledValue(line, ["مشخصات نشر", "سال انتشار", "سال نشر"]);
      if (!pubSpec) continue;
      const yearMatch = pubSpec.match(/([۰-۹0-9]{4})\s*$/);
      if (yearMatch) {
        result.publish_year = toEnglishDigits(yearMatch[1]);
        break;
      }
    }
  }

  return sanitizeBookRecord(result);
}

function pickLabeledValue(line, labels) {
  for (const label of labels) {
    const rx = new RegExp(`${escapeRegex(label)}\\s*[:：\\-]?\\s*([^\\n*"{;؛]+)`, "i");
    const match = `${line || ""}`.match(rx);
    if (match?.[1]) return sanitizeFieldValue(match[1]);
  }
  return "";
}

function isMetadataLine(line) {
  return /^(سرشناسه|نویسنده|نگارنده|مترجم|ویراستار|تصویرگر|گردآورنده|ناشر|انتشارات|نشر|محل نشر|سال|صفحات|تعداد صفحات|شماره جلد|فروست|مجموعه|موضوع|رده|isbn|شابک)/i.test(
    cleanField(line)
  );
}

function looksLikePersonName(line) {
  const text = cleanField(line);
  if (!text || text.length > 80) return false;
  if (isMetadataLine(text)) return false;
  if (findIsbn(text) || normalizeYear(text)) return false;
  if (/(انتشارات|نشر|تهران|مشهد|چاپ|ویرایش|صفحات|شابک)/.test(text)) return false;
  return /[\u0600-\u06FF]/.test(text);
}

function appendUnique(current, next) {
  const value = sanitizeFieldValue(next);
  if (!value || isPlaceholderValue(value)) return sanitizeFieldValue(current);
  const base = sanitizeFieldValue(current);
  if (!base) return value;
  if (base.includes(value)) return base;
  return `${base} | ${value}`;
}

function normalizeYear(value) {
  const text = cleanField(value);
  const match = text.match(/[۰-۹0-9]{4}/);
  if (!match) return "";
  return toEnglishDigits(match[0]);
}

function toEnglishDigits(value) {
  const map = {
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9"
  };
  return `${value}`.replace(/[۰-۹]/g, (d) => map[d] || d);
}

function normalizeBookPayload(obj) {
  if (!obj || typeof obj !== "object") return {};
  // Some model responses are wrapped like: { response: { ...fields } }
  const candidate =
    obj.response && typeof obj.response === "object" ? obj.response : obj;
  return {
    main_entry: candidate.main_entry ?? candidate.heading ?? candidate.authors ?? candidate.author ?? "",
    title: candidate.title ?? candidate.book_title ?? "",
    subtitle: candidate.subtitle ?? "",
    parallel_title: candidate.parallel_title ?? candidate.uniform_title ?? "",
    creators:
      candidate.creators ??
      candidate.statement_of_responsibility ??
      candidate.contributors ??
      "",
    authors: candidate.authors ?? candidate.author ?? "",
    translators: candidate.translators ?? candidate.translator ?? "",
    editors: candidate.editors ?? candidate.editor ?? "",
    illustrators: candidate.illustrators ?? candidate.illustrator ?? "",
    compilers: candidate.compilers ?? candidate.compiler ?? candidate.collector ?? "",
    publisher: candidate.publisher ?? candidate.publication ?? "",
    publication_place: candidate.publication_place ?? candidate.place ?? "",
    publish_year: candidate.publish_year ?? candidate.year ?? "",
    copyright_date: candidate.copyright_date ?? candidate.copyright ?? "",
    print_year: candidate.print_year ?? "",
    edition: candidate.edition ?? "",
    extent: candidate.extent ?? candidate.pages ?? candidate.volume ?? "",
    dimensions: candidate.dimensions ?? "",
    accompanying_material: candidate.accompanying_material ?? candidate.materials ?? "",
    volume_number: candidate.volume_number ?? "",
    series_title: candidate.series_title ?? candidate.series ?? "",
    series_number: candidate.series_number ?? "",
    added_entries: candidate.added_entries ?? "",
    language: candidate.language ?? "",
    subjects: candidate.subjects ?? candidate.subject ?? "",
    call_number: candidate.call_number ?? "",
    cover_text: candidate.cover_text ?? candidate.legal_page_text ?? "",
    isbn: candidate.isbn ?? candidate.ISBN ?? "",
    notes: candidate.notes ?? candidate.confidence_notes ?? "",
    statement_of_responsibility: candidate.statement_of_responsibility ?? ""
  };
}

function cleanField(value) {
  return `${value ?? ""}`
    .normalize("NFKC")
    .replace(/\u200c/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .trim();
}

function parseBookFields(text, visibleLines = []) {
  const normalized = `${text || ""}`;
  const lineText = visibleLines.join("\n");
  const title =
    pickField(normalized, "TITLE") ||
    pickField(normalized, "عنوان") ||
    firstNonEmptyLine(lineText || normalized);
  const authors =
    pickField(normalized, "CREATORS") ||
    pickField(normalized, "AUTHORS") ||
    pickField(normalized, "نویسنده") ||
    "";
  const isbn = pickField(normalized, "ISBN") || findIsbn(lineText || normalized);

  return {
    main_entry:
      pickField(normalized, "MAIN_ENTRY") ||
      pickField(normalized, "سرشناسه") ||
      authors ||
      "",
    title: title || "",
    subtitle: pickField(normalized, "SUBTITLE") || pickField(normalized, "عنوان فرعی") || "",
    parallel_title: pickField(normalized, "PARALLEL_TITLE") || pickField(normalized, "عنوان برابر") || "",
    creators: pickField(normalized, "CREATORS") || pickField(normalized, "شرح پدیدآور") || "",
    authors: authors || "",
    translators: pickField(normalized, "TRANSLATORS") || pickField(normalized, "مترجم") || "",
    editors: pickField(normalized, "EDITORS") || pickField(normalized, "ویراستار") || "",
    illustrators: pickField(normalized, "ILLUSTRATORS") || pickField(normalized, "تصویرگر") || "",
    compilers: pickField(normalized, "COMPILERS") || pickField(normalized, "گردآورنده") || "",
    publisher: pickField(normalized, "PUBLISHER") || pickField(normalized, "ناشر") || "",
    publication_place:
      pickField(normalized, "PUBLICATION_PLACE") || pickField(normalized, "محل نشر") || "",
    publish_year:
      pickField(normalized, "PUBLISH_YEAR") ||
      pickField(normalized, "سال") ||
      pickField(normalized, "YEAR") ||
      "",
    copyright_date: pickField(normalized, "COPYRIGHT_DATE") || pickField(normalized, "سال حقوق") || "",
    print_year: pickField(normalized, "PRINT_YEAR") || pickField(normalized, "سال چاپ") || "",
    edition: pickField(normalized, "EDITION") || pickField(normalized, "نوبت چاپ") || "",
    extent: pickField(normalized, "EXTENT") || pickField(normalized, "صفحات") || "",
    dimensions: pickField(normalized, "DIMENSIONS") || pickField(normalized, "ابعاد") || "",
    accompanying_material:
      pickField(normalized, "ACCOMPANYING_MATERIAL") || pickField(normalized, "مواد همراه") || "",
    volume_number: pickField(normalized, "VOLUME_NUMBER") || pickField(normalized, "شماره جلد") || "",
    series_title: pickField(normalized, "SERIES_TITLE") || pickField(normalized, "فروست") || "",
    series_number: pickField(normalized, "SERIES_NUMBER") || pickField(normalized, "شماره فروست") || "",
    added_entries: pickField(normalized, "ADDED_ENTRIES") || pickField(normalized, "سرشناسه افزوده") || "",
    language: pickField(normalized, "LANGUAGE") || "",
    subjects: pickField(normalized, "SUBJECTS") || pickField(normalized, "موضوع") || "",
    call_number: pickField(normalized, "CALL_NUMBER") || pickField(normalized, "رده") || "",
    cover_text: pickField(normalized, "COVER_TEXT") || lineText,
    isbn: isbn || "",
    notes: ""
  };
}

function buildCoverLinesPrompt() {
  return {
    system: [
      "شما متخصص خواندن دقیق صفحات حقوقی (شناسنامه) کتاب فارسی و انگلیسی هستید.",
      "طبق AACR2 منبع اصلی اطلاعات صفحات حقوقی کتاب است.",
      "فقط آنچه واقعا در تصویر دیده می‌شود را استخراج کن.",
      "حدس نزن و هیچ دانشی خارج از تصویر اضافه نکن.",
      "خروجی باید متن یونیکد فارسی را به صورت طبیعی و خوانا برگرداند، نه escape شده و نه به هم ریخته.",
      "فقط JSON معتبر در پاسخ content برگردان.",
      "هیچ توضیح، reasoning، markdown یا JSON API برنگردان."
    ].join("\n"),
    user: [
      "مرحله ۱: فقط خطوط صفحات حقوقی/فیپا را استخراج کن.",
      "هر خط فقط یک برچسب و مقدار کوتاه داشته باشد.",
      'خروجی فقط این ساختار باشد: {"language":"fa|en|unknown","visible_text_lines":["...", "..."],"confidence_notes":"..."}'
    ].join(" ")
  };
}

function buildStructuredPrompt(visibleLines) {
  const joined = visibleLines.length ? visibleLines.join("\n") : "(no visible text)";
  return {
    system: [
      "شما متخصص فهرست‌نویسی کتاب طبق AACR2 هستید.",
      "فقط از خطوط داده شده استفاده کن.",
      "اگر چیزی در خطوط نیست، خالی بگذار.",
      "حدس نزن و دانش بیرونی اضافه نکن.",
      "خروجی باید متن فارسی Unicode/UTF-8 تمیز و خوانا داشته باشد.",
      "فقط JSON معتبر در پاسخ content برگردان.",
      "هیچ توضیح، reasoning، markdown یا JSON API برنگردان."
    ].join("\n"),
    user: [
      "مرحله ۲: از روی خطوط صفحات حقوقی، فیلدهای AACR2 را پر کن.",
      "main_entry = سرشناسه / ورود اصلی (100).",
      "title = عنوان اصلی (245$a). subtitle = عنوان فرعی (245$b). parallel_title = عنوان برابر (246).",
      "creators = شرح پدیدآور (245$c). authors/translators/editors/illustrators/compilers جدا پر شوند.",
      "edition = ویرایش (250). publication_place/publisher/publish_year/copyright_date = نشرداده (260).",
      "extent = تعداد صفحات یا مشخصات ظاهری (300$a). dimensions = ابعاد (300$c). accompanying_material = مواد همراه (300$e).",
      "volume_number = شماره جلد (245$n). series_title/series_number = فروست (490).",
      "added_entries = سرشناسه‌های افزوده. isbn = شابک (020). subjects = موضوع (650). call_number = رده (082).",
      "cover_text = خلاصه متن صفحات حقوقی. notes فقط توضیح اختیاری.",
      `خروجی فقط این ساختار باشد: ${AACR2_STRUCTURED_JSON}`,
      "",
      "LINES:",
      joined
    ].join("\n")
  };
}

function parseVisibleTextLines(text) {
  return extractCatalogLines(text, []);
}

function safeJsonParse(text) {
  if (isGarbageField(text)) return null;
  try {
    const match = `${text || ""}`.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);
    if (obj?.choices || obj?.object === "chat.completion") return null;
    return obj;
  } catch {
    return null;
  }
}

function pickField(text, key) {
  const rx = new RegExp(`${escapeRegex(key)}\\s*:\\s*(.+)`, "i");
  const m = text.match(rx);
  return m?.[1]?.trim() || "";
}

function firstNonEmptyLine(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
}

function findIsbn(text) {
  const m = text.match(/97[89][-\s]?\d[-\s]?\d+[-\s]?\d+[-\s]?[\dxX]/);
  return m?.[0] || "";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function csvEscape(value) {
  const s = `${value ?? ""}`;
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function safeName(name) {
  return `${name}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function toDataUrl(bytes, mime) {
  const bin = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < bin.length; i++) binary += String.fromCharCode(bin[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers
  });
}
