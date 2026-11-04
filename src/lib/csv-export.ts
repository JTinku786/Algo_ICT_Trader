type CsvColumn<Row> = {
  key: string;
  value: (row: Row) => unknown;
};

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown) {
  return `"${csvValue(value).replace(/"/g, '""')}"`;
}

export function buildCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]) {
  const header = columns.map((column) => csvCell(column.key)).join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(","));
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

export function selectedCsvKeys(raw: string | null, allowed: readonly string[], defaults: readonly string[]) {
  const allowedSet = new Set(allowed);
  const requested = (raw || "").split(",").map((value) => value.trim()).filter((value) => allowedSet.has(value));
  return requested.length ? [...new Set(requested)] : [...defaults];
}

export function csvDownloadResponse(csv: string, filename: string, rowCount: number) {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Export-Row-Count": String(rowCount),
    },
  });
}

