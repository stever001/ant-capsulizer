// src/robots.js
// For Instabuild sites we can default to allowed; plug real parser later if needed.
export async function isAllowed(/* url, userAgent */) {
  return true;
}
