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
  const structuredPrompt = buildStructuredPrompt(stage1.lines);

  let structuredText = null;
  let stage2Model = null;
  let stage2Attempts = [];
  let lastError = null;
  const stage2StartedAt = Date.now();

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

  if (!structuredText?.trim()) {
    throw lastError || new Error("مدل هوش مصنوعی پاسخی برنگرداند");
  }

  const stage2Ms = Date.now() - stage2StartedAt;
  const totalMs = Date.now() - startedAt;

  const combinedRaw = JSON.stringify(
    {
      stage1_model: stage1.model,
      stage1_duration_ms: stage1.durationMs,
      stage1_attempts: stage1.attempts,
      stage1_visible_lines: stage1.lines,
      stage1_raw: stage1.raw,
      stage2_model: stage2Model,
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
    parsed: parseBookJson(structuredText, stage1.lines),
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

  throw lastError || new Error("خواندن متن روی جلد انجام نشد");
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
  if (typeof result === "string") return result;
  if (typeof result?.answer === "string") return result.answer;
  if (typeof result?.caption === "string") return result.caption;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.result?.response === "string") return result.result.response;
  if (Array.isArray(result?.choices)) {
    const content = result.choices[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n");
    }
  }
  return JSON.stringify(result);
}

function parseBookJson(text, visibleLines = []) {
  const payload = extractStructuredPayload(text);
  const fromStructured = mapPayloadToBook(payload);
  const fromLines = inferFieldsFromVisibleLines(visibleLines);
  const merged = mergeBookFields(fromStructured, fromLines);

  if (!merged.cover_text) {
    merged.cover_text = visibleLines.join("\n");
  }
  if (!merged.isbn) {
    merged.isbn = findIsbn([text, visibleLines.join("\n")].join("\n"));
  }

  merged.notes = cleanField(payload.confidence_notes) || "";

  const hasCoreField = Boolean(
    merged.title ||
      merged.authors ||
      merged.publisher ||
      merged.isbn ||
      merged.creators
  );
  if (!hasCoreField && visibleLines.length) {
    return parseBookFields(text, visibleLines);
  }

  return merged;
}

function extractStructuredPayload(text) {
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== "object") return {};
  if (parsed.response && typeof parsed.response === "object") return parsed.response;
  if (parsed.stage2_structured && typeof parsed.stage2_structured === "object") {
    return parsed.stage2_structured;
  }
  return parsed;
}

function mapPayloadToBook(payload) {
  const normalized = normalizeBookPayload(payload);
  return {
    title: cleanField(normalized.title),
    subtitle: cleanField(normalized.subtitle),
    creators: cleanField(normalized.creators),
    authors: cleanField(normalized.authors),
    translators: cleanField(normalized.translators),
    editors: cleanField(normalized.editors),
    illustrators: cleanField(normalized.illustrators),
    compilers: cleanField(normalized.compilers),
    publisher: cleanField(normalized.publisher),
    publication_place: cleanField(normalized.publication_place),
    publish_year: cleanField(normalized.publish_year),
    print_year: cleanField(normalized.print_year),
    edition: cleanField(normalized.edition),
    volume: cleanField(normalized.volume),
    series_title: cleanField(normalized.series_title),
    language: cleanField(normalized.language),
    category: cleanField(normalized.category),
    subjects: cleanField(normalized.subjects),
    tags: cleanField(normalized.tags),
    call_number: cleanField(normalized.call_number),
    cover_text: cleanField(normalized.cover_text),
    isbn: cleanField(normalized.isbn),
    notes: cleanField(normalized.notes)
  };
}

function mergeBookFields(primary, fallback) {
  const keys = [
    "title",
    "subtitle",
    "creators",
    "authors",
    "translators",
    "editors",
    "illustrators",
    "compilers",
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
    "isbn",
    "notes"
  ];
  const merged = {};
  for (const key of keys) {
    merged[key] = cleanField(primary[key]) || cleanField(fallback[key]) || "";
  }
  return merged;
}

function inferFieldsFromVisibleLines(lines = []) {
  const result = {};
  const contentLines = [];

  for (const rawLine of lines) {
    const line = cleanField(rawLine);
    if (!line) continue;

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

    const edition = pickLabeledValue(line, ["نوبت چاپ", "ویرایش", "edition"]);
    if (edition && !result.edition) result.edition = edition;

    const volume = pickLabeledValue(line, ["جلد", "volume"]);
    if (volume) result.volume = appendUnique(result.volume, volume);

    const series = pickLabeledValue(line, ["مجموعه", "سری", "series"]);
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
      const year = normalizeYear(line);
      if (year) {
        result.publish_year = year;
        break;
      }
    }
  }

  return result;
}

function pickLabeledValue(line, labels) {
  for (const label of labels) {
    const rx = new RegExp(`${escapeRegex(label)}\\s*[:：\\-]?\\s*(.+)$`, "i");
    const match = line.match(rx);
    if (match?.[1]) return cleanField(match[1]);
  }
  return "";
}

function isMetadataLine(line) {
  return /^(نویسنده|نگارنده|مترجم|ویراستار|تصویرگر|گردآورنده|ناشر|انتشارات|نشر|محل نشر|سال|جلد|مجموعه|موضوع|رده|isbn|شابک)/i.test(
    cleanField(line)
  );
}

function looksLikePersonName(line) {
  const text = cleanField(line);
  if (!text || text.length > 80) return false;
  if (isMetadataLine(text)) return false;
  if (findIsbn(text) || normalizeYear(text)) return false;
  if (/(انتشارات|نشر|تهران|مشهد|جلد|چاپ|ویرایش)/.test(text)) return false;
  return /[\u0600-\u06FF]/.test(text);
}

function appendUnique(current, next) {
  const value = cleanField(next);
  if (!value) return cleanField(current);
  const base = cleanField(current);
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
    title: candidate.title ?? candidate.book_title ?? "",
    subtitle: candidate.subtitle ?? "",
    creators:
      candidate.creators ??
      candidate.contributors ??
      candidate.authors ??
      candidate.author ??
      "",
    authors: candidate.authors ?? candidate.author ?? "",
    translators: candidate.translators ?? candidate.translator ?? "",
    editors: candidate.editors ?? candidate.editor ?? "",
    illustrators: candidate.illustrators ?? candidate.illustrator ?? "",
    compilers: candidate.compilers ?? candidate.compiler ?? candidate.collector ?? "",
    publisher: candidate.publisher ?? candidate.publication ?? "",
    publication_place: candidate.publication_place ?? candidate.place ?? "",
    publish_year: candidate.publish_year ?? candidate.year ?? "",
    print_year: candidate.print_year ?? "",
    edition: candidate.edition ?? "",
    volume: candidate.volume ?? "",
    series_title: candidate.series_title ?? candidate.series ?? "",
    language: candidate.language ?? "",
    category: candidate.category ?? "",
    subjects: candidate.subjects ?? "",
    tags: candidate.tags ?? "",
    call_number: candidate.call_number ?? "",
    cover_text: candidate.cover_text ?? "",
    isbn: candidate.isbn ?? candidate.ISBN ?? "",
    notes: candidate.notes ?? candidate.confidence_notes ?? ""
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
    title: title || "",
    subtitle: pickField(normalized, "SUBTITLE") || pickField(normalized, "زیرعنوان") || "",
    creators: pickField(normalized, "CREATORS") || "",
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
    print_year: pickField(normalized, "PRINT_YEAR") || pickField(normalized, "سال چاپ") || "",
    edition: pickField(normalized, "EDITION") || pickField(normalized, "نوبت چاپ") || "",
    volume: pickField(normalized, "VOLUME") || pickField(normalized, "جلد") || "",
    series_title: pickField(normalized, "SERIES_TITLE") || pickField(normalized, "مجموعه") || "",
    language: pickField(normalized, "LANGUAGE") || "",
    category: pickField(normalized, "CATEGORY") || pickField(normalized, "دسته‌بندی") || "",
    subjects: pickField(normalized, "SUBJECTS") || pickField(normalized, "موضوع") || "",
    tags: pickField(normalized, "TAGS") || "",
    call_number: pickField(normalized, "CALL_NUMBER") || pickField(normalized, "رده") || "",
    cover_text: pickField(normalized, "COVER_TEXT") || lineText,
    isbn: isbn || "",
    notes: ""
  };
}

function buildCoverLinesPrompt() {
  return {
    system: [
      "شما متخصص خواندن دقیق نوشته های روی جلد کتاب فارسی و انگلیسی هستید.",
      "فقط آنچه واقعا روی جلد دیده می شود را استخراج کن.",
      "حدس نزن و هیچ دانشی خارج از تصویر اضافه نکن.",
      "خروجی باید متن یونیکد فارسی را به صورت طبیعی و خوانا برگرداند، نه escape شده و نه به هم ریخته.",
      "فقط JSON معتبر برگردان."
    ].join("\n"),
    user: [
      "مرحله ۱: فقط متن های قابل مشاهده روی جلد را بخوان و خط به خط استخراج کن.",
      "ترتیب خطوط را از مهم ترین متن به کم اهمیت تر نگه دار.",
      "اگر یک عبارت ناقص یا نامطمئن است آن را همان طور که دیده می شود ثبت کن و اصلاح نکن.",
      "اگر متن فارسی است همان حروف فارسی UTF-8 را حفظ کن.",
      'خروجی فقط این ساختار باشد: {"language":"fa|en|unknown","visible_text_lines":["...", "..."],"confidence_notes":"..."}'
    ].join(" ")
  };
}

function buildStructuredPrompt(visibleLines) {
  const joined = visibleLines.length ? visibleLines.join("\n") : "(no visible text)";
  return {
    system: [
      "شما متخصص ساختاربندی نوشته های روی جلد کتاب هستید.",
      "فقط از خطوط داده شده استفاده کن.",
      "اگر چیزی در خطوط نیست، خالی بگذار.",
      "حدس نزن و دانش بیرونی اضافه نکن.",
      "خروجی باید متن فارسی Unicode/UTF-8 تمیز و خوانا داشته باشد.",
      "فقط JSON معتبر برگردان."
    ].join("\n"),
    user: [
      "مرحله ۲: از روی خطوط زیر، اطلاعات جلد را ساختاربندی کن.",
      "title فقط نام اصلی کتاب باشد.",
      "subtitle فقط اگر واضح است پر شود.",
      "creators شامل همه پدیدآورندگان با نقششان باشد، مثل: نویسنده: ... | مترجم: ...",
      "authors فقط نام نویسنده ها، translators فقط نام مترجم ها، editors فقط نام ویراستارها، illustrators فقط نام تصویرگرها، compilers فقط نام گردآورنده ها.",
      "publisher و publication_place و publish_year و print_year و edition و volume و series_title و isbn فقط اگر در خطوط دیده می شوند پر شوند.",
      "category و subjects و call_number فقط اگر واقعا روی جلد آمده باشند پر شوند.",
      "cover_text خلاصه ای کوتاه از مهم ترین نوشته های جلد باشد.",
      "هیچ فیلدی را داخل notes نگذار. notes فقط برای توضیح اختیاری مدل است.",
      "همه اطلاعات قابل استخراج باید در فیلدهای اختصاصی خودشان قرار بگیرند.",
      'خروجی فقط این ساختار باشد: {"title":"","subtitle":"","creators":"","authors":"","translators":"","editors":"","illustrators":"","compilers":"","publisher":"","publication_place":"","publish_year":"","print_year":"","edition":"","volume":"","series_title":"","language":"fa","isbn":"","category":"","subjects":"","tags":"","call_number":"","cover_text":""}',
      "",
      "LINES:",
      joined
    ].join("\n")
  };
}

function parseVisibleTextLines(text) {
  const parsed = safeJsonParse(text);
  if (parsed && Array.isArray(parsed.visible_text_lines)) {
    return parsed.visible_text_lines.map((x) => `${x ?? ""}`.trim()).filter(Boolean);
  }
  const lines = `${text || ""}`
    .split(/\r?\n/)
    .map((x) => x.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter(Boolean);
  return lines;
}

function safeJsonParse(text) {
  try {
    const match = `${text || ""}`.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
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
