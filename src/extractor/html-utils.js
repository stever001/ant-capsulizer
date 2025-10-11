// src/extractor/html-utils.js
import cheerio from 'cheerio';
import { absolute, trimAny } from '../normalize.js';

export function parseHTML(html) { return cheerio.load(html); }

export function meta($, name) {
  return $('meta[name="'+name+'"]').attr('content')
      || $('meta[property="'+name+'"]').attr('content');
}

export function guessName($, baseUrl) {
  return meta($,'og:site_name')
      || $('header h1').first().text().trim()
      || $('title').text().trim()
      || new URL(baseUrl).hostname.replace(/^www\./,'');
}

export function guessDescription($) {
  return meta($,'description') || meta($,'og:description') || '';
}

export function guessLogo($, baseUrl) {
  let logo = $('img[alt*="logo" i]').attr('src')
         || $('link[rel="icon"]').attr('href')
         || meta($,'og:image');
  if (logo) logo = absolute(logo, baseUrl);
  return logo || null;
}

export function guessPhone($) {
  const tel = $('a[href^="tel:"]').attr('href');
  if (tel) return tel.replace(/^tel:/,'');
  const text = $('body').text();
  const m = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0] : null;
}

export function guessAddress($) {
  // Try <address>, footer, schema-ish spans
  const a = $('address').first().text() || $('footer').text();
  const clean = trimAny(a);
  return clean && clean.length > 10 ? clean : null; // simple presence check
}

export function guessHours($) {
  const t = $('body').text();
  const m = t.match(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]{0,40}\d{1,2}:\d{2}\s?[-–]\s?\d{1,2}:\d{2}/i);
  return m ? [m[0].replace(/\s+/g,' ').trim()] : null;
}

export function socialLinks($, baseUrl) {
  const links = [];
  $('a[href]').each((_,a)=>{
    const href = $(a).attr('href');
    if (/facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com/i.test(href||'')) {
      links.push(absolute(href, baseUrl));
    }
  });
  return Array.from(new Set(links)).filter(Boolean);
}
