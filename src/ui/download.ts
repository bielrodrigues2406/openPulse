/** Hands the viewer a file. In the desktop app the main process saves it to Documents/openPulse. */
export function download(filename: string, data: string | Uint8Array, mime: string): void {
  const part = typeof data === 'string' ? data : data.slice().buffer;
  const url = URL.createObjectURL(new Blob([part], { type: typeof data === 'string' ? `${mime};charset=utf-8` : mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
