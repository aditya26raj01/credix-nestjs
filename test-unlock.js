const fs = require('fs');

async function readProtectedPDF(path, password) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(path));

  const loadingTask = pdfjsLib.getDocument({
    data,
    password,
  });

  try {
    const pdf = await loadingTask.promise;

    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      const strings = content.items.map((item) => item.str);
      fullText += strings.join(' ') + '\n';
    }

    return fullText;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new Error('Incorrect password or password required');
    }
    throw err;
  }
}

// usage
readProtectedPDF('20000010775795_21042026_190725169.pdf', '2601')
  .then(console.log)
  .catch(console.error);
