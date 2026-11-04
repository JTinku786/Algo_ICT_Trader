export async function downloadCsv(url: string, fallbackFilename: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json() as { error?: string };
      throw new Error(payload.error || `CSV export failed (${response.status})`);
    }
    throw new Error((await response.text()) || `CSV export failed (${response.status})`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackFilename;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);

  return Number(response.headers.get("x-export-row-count") || 0);
}
