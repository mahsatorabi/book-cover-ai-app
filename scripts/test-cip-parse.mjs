/**
 * Quick regression test for Persian CIP parsing (run: node scripts/test-cip-parse.mjs)
 */
import { readFileSync } from "node:fs";

const workerSource = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const lines = workerSource.split("\n");
const start = lines.findIndex((line) => line.startsWith("function extractModelText"));
const end = lines.findIndex((line) => line.startsWith("function buildCoverLinesPrompt"));
const tailStart = lines.findIndex((line) => line.startsWith("function safeJsonParse"));
const tailEnd = lines.findIndex((line) => line.startsWith("function csvEscape"));

const moduleSource = `${lines.slice(start, end).join("\n")}\n${lines.slice(tailStart, tailEnd).join("\n")}\nexport {
  extractCatalogLines,
  parsePersianCipRecord,
  parseBookJson,
  sanitizeFieldValue,
  isGarbageField
};`;

const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(moduleSource)}`;
const mod = await import(dataUrl);

const sampleReasoning = `
*   سرشناسه: دبب، بهنام، ۱۳۷۸.
*   عنوان و نام پدیدآور: کلنبه باغ شاعران: مخصوص مشاوره - الغایی.
*   گردآورنده: بهنام دبب؛ ویراستار: زهرا صنوبرى.
*   مشخصات نشر: تهران: متخصصان، ۱۴۰۲.
*   مشخصات ظاهری: ۳۶ ص. : قطع رقعی.
*   موضوع: مشاوره - Mosha'erah - Collections
*   شناسه افزوده: صنوبرى، زهرا، ۱۳۵۸.
*   رده بندی کنگره: PIR408:D6
*   رده بندی دیویی: 840/8
*   نوبت چاپ: اول (بهار ۱۴۰۲)
*   شابک: ۹۷۸-۶۲۲-۷۳۵۷-۷۷-۶
`;

const apiGarbage = '{"choices":[{"finish_reason":"length","message":{"content":null,"reasoning":"ignored"}}]}';
const catalogLines = mod.extractCatalogLines(sampleReasoning, []);
const parsed = mod.parsePersianCipRecord(catalogLines);
const fromJson = mod.parseBookJson(apiGarbage, catalogLines);

const garbagePayload = JSON.stringify({
  language: "fa|en|unknown",
  visible_text_lines: ["visible_text_lines"],
  title: "fa|en|unknown",
  subtitle: "visible_text_lines",
  translators: "s",
  extent: ". Follow AACR2 principles",
  accompanying_material: "_material",
  series_title: "_title | _number",
  subjects: "s"
});
const fromGarbageOnly = mod.parseBookJson(garbagePayload, []);
const fromGarbageWithCip = mod.parseBookJson(garbagePayload, catalogLines);

const kimiaSample = {
  main_entry: "پاتید کیمییا (Author: Patid Kimia -",
  title: "Top line: داستان های کوتاه (Short Stories)",
  subtitle: "Large title: قند سفید (White Sugar)",
  editors: "دکتر مژگان خسروی پور (Editor: Dr. Mozhgan Khosravipour)",
  edition: "اول ایاپز (۱۴۰۲) (Print edition: First [something] 1402) -> Actually",
  publication_place: "تهران",
  publisher: "متخصصان",
  publish_year: "1402"
};
const kimiaParsed = mod.parseBookJson(JSON.stringify(kimiaSample), []);

const checks = [
  ["main_entry", parsed.main_entry, "دبب، بهنام، ۱۳۷۸"],
  ["title", parsed.title, "کلنبه باغ شاعران"],
  ["subtitle", parsed.subtitle, "مخصوص مشاوره - الغایی"],
  ["compilers", parsed.compilers, "بهنام دبب"],
  ["editors", parsed.editors, "زهرا صنوبرى"],
  ["publisher", parsed.publisher, "متخصصان"],
  ["publish_year", parsed.publish_year, "1402"],
  ["extent", parsed.extent.includes("۳۶"), true],
  ["isbn present", Boolean(parsed.isbn), true],
  ["no garbage in title", mod.isGarbageField(fromJson.title), false],
  ["publish_year not birth year", parsed.publish_year !== "1378", true],
  ["reject schema-only title", fromGarbageOnly.title, ""],
  ["reject schema-only subtitle", fromGarbageOnly.subtitle, ""],
  ["reject prompt extent from schema", fromGarbageOnly.extent, ""],
  ["reject single-letter translator", fromGarbageOnly.translators, ""],
  ["cip title kept over garbage", fromGarbageWithCip.title, parsed.title],
  ["strip layout prefix from title", kimiaParsed.title, "داستان های کوتاه"],
  ["strip layout prefix from subtitle", kimiaParsed.subtitle, "قند سفید"],
  ["strip author annotation", kimiaParsed.main_entry.includes("Author"), false],
  ["strip editor english", kimiaParsed.editors, "دکتر مژگان خسروی پور"],
  ["parallel title from english", kimiaParsed.parallel_title.includes("Short Stories") || kimiaParsed.parallel_title.includes("White Sugar"), true]
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  console.log(`${ok ? "OK" : "FAIL"} ${name}: ${JSON.stringify(actual)}`);
  if (!ok) failed += 1;
}

process.exit(failed ? 1 : 0);
