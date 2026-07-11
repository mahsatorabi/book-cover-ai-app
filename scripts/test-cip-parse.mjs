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
  ["publish_year not birth year", parsed.publish_year !== "1378", true]
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  console.log(`${ok ? "OK" : "FAIL"} ${name}: ${JSON.stringify(actual)}`);
  if (!ok) failed += 1;
}

process.exit(failed ? 1 : 0);
