/**
 * Generates docs/SENSEI_PROJECT_GUIDE.pdf from docs/SENSEI_PROJECT_GUIDE.html
 * Usage: node scripts/generate-project-pdf.js
 *
 * Uses Chrome/Edge headless CLI (no npm dependencies required).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  return BROWSERS.find((p) => fs.existsSync(p));
}

function main() {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'SENSEI_PROJECT_GUIDE.html');
  const pdfPath = path.resolve(__dirname, '..', 'docs', 'SENSEI_PROJECT_GUIDE.pdf');

  if (!fs.existsSync(htmlPath)) {
    console.error('Missing:', htmlPath);
    process.exit(1);
  }

  const browser = findBrowser();
  if (!browser) {
    console.error('Install Chrome or Edge, or open docs/SENSEI_PROJECT_GUIDE.html → Print → Save as PDF');
    process.exit(1);
  }

  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const cmd = `"${browser}" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="${pdfPath}" "${fileUrl}"`;
  execSync(cmd, { stdio: 'inherit' });

  if (!fs.existsSync(pdfPath)) {
    console.error('PDF generation failed');
    process.exit(1);
  }
  const sizeKb = Math.round(fs.statSync(pdfPath).size / 1024);
  console.log(`PDF written: ${pdfPath} (${sizeKb} KB)`);
}

main();
