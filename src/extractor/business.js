// src/extractor/business.js
const cheerio = require('cheerio');
const { trimAny } = require('../normalize');

function extractBusinessCapsule(html, url, owner_slug) {
  const $ = cheerio.load(html);
  const name = $('meta[property="og:site_name"]').attr('content') ||
               $('h1').first().text().trim() ||
               $('title').text().trim();
  const description = $('meta[name="description"]').attr('content') || '';
  const logo = $('img[alt*="logo" i]').attr('src') ||
               $('link[rel="icon"]').attr('href') || null;
  const telephone = $('a[href^="tel:"]').attr('href')?.replace(/^tel:/,'') || null;
  const address = $('address').first().text().trim() || null;
  const social = [];
  $('a[href]').each((i,a)=>{
    const h = $(a).attr('href');
    if(/facebook|instagram|x\.com|twitter|linkedin/i.test(h)) social.push(h);
  });

  return {
    "@context": "https://agentnet.ai/context",
    "@type": "agentnet:BusinessCapsule",
    "@id": `agentnet://resolver/${owner_slug}#${Date.now()}`,
    "agentnet:sourceUrl": url,
    "agentnet:owner": owner_slug,
    "name": trimAny(name),
    "description": trimAny(description),
    "logo": logo,
    "telephone": telephone,
    "address": address,
    "sameAs": social,
    "agentnet:harvestedAt": new Date().toISOString()
  };
}

module.exports = { extractBusinessCapsule };
