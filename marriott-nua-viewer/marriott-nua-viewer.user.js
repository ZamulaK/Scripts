// ==UserScript==
// @name         Marriott NUA Selections Viewer
// @namespace    danbrum.marriott.nua
// @version      3.10.0
// @description  Shows the Nightly Upgrade Award room choices attached to reservations, on the upgrade page and on the reservation list.
// @homepageURL  https://github.com/ZamulaK/Scripts/tree/main/marriott-nua-viewer
// @updateURL    https://raw.githubusercontent.com/ZamulaK/Scripts/main/marriott-nua-viewer/marriott-nua-viewer.user.js
// @downloadURL  https://raw.githubusercontent.com/ZamulaK/Scripts/main/marriott-nua-viewer/marriott-nua-viewer.user.js
// @match        https://www.marriott.com/loyalty/requestNightlyUpgradeAwards.mi*
// @match        https://www.marriott.com/loyalty/findReservationList.mi*
// @match        https://www.marriott.com/reservation/upcomingReservation.mi*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const IMAGE_BASE = 'https://cache.marriott.com';
  const ACCENT = '#BF360C'; // Accent color for status, choice pills, count badge, and link hover
  // Header summary style: 'pill' = one labeled pill ("7 Awards | 3 Stays"); 'subtitle' = awards circle plus a grey line under the title.
  const HEADER_STYLE = 'pill';
  const PANEL_ID = 'nua-viewer-panel';
  const TEMPLATE_KEY = 'nuaViewer.requestTemplate';
  const IS_LIST_PAGE = location.pathname.indexOf('findReservationList') !== -1;
  const IS_DETAIL_PAGE = location.pathname.indexOf('upcomingReservation') !== -1;
  // Pages where the panel starts collapsed and only appears when a reservation has awards attached.
  const IS_SUMMARY_PAGE = IS_LIST_PAGE || IS_DETAIL_PAGE;
  const LOG = (...a) => console.log('[NUA Viewer]', ...a);

  // Built-in copy of the NUA GraphQL request, so the list page works without visiting an upgrade page first.
  // If Marriott changes the query, visiting any upgrade page once saves a learned copy that overrides this.
  const BUILT_IN_BODY = "{\"operationName\":\"phoenixAccountDttGetNightlyUpgradeAwards\",\"variables\":{\"input\":{\"confirmationNumber\":\"95015195\"}},\"query\":\"query phoenixAccountDttGetNightlyUpgradeAwards($input: CommerceOrderByConfirmationNumberInput!) {\\n  commerce {\\n    order {\\n      orderByConfirmationNumber(input: $input) {\\n        ... on ResponseStatus {\\n          ...phoenixAccountDttResponseErrorStatus\\n          __typename\\n        }\\n        ... on CommerceOrder {\\n          items {\\n            id\\n            basicInformation {\\n              id\\n              endDate\\n              startDate\\n              isModifiable\\n              bookingLanguage\\n              lengthOfStay\\n              migratedConfirmationNumber\\n              __typename\\n            }\\n            property {\\n              ... on Hotel {\\n                basicInformation {\\n                  ... on HotelBasicInformation {\\n                    marshaBrandCode\\n                    __typename\\n                  }\\n                  __typename\\n                }\\n                otherPropertyInformation {\\n                  crsSystem\\n                  __typename\\n                }\\n                __typename\\n              }\\n              __typename\\n            }\\n            nuaInformation {\\n              nuaRequestStatus {\\n                roomTypes {\\n                  roomInformation {\\n                    id\\n                    description\\n                    photoGallery {\\n                      ... on HotelRoomProductImageConnection {\\n                        edges {\\n                          node {\\n                            imageUrls {\\n                              classicHorizontal\\n                              __typename\\n                            }\\n                            __typename\\n                          }\\n                          __typename\\n                        }\\n                        __typename\\n                      }\\n                      __typename\\n                    }\\n                    __typename\\n                  }\\n                  __typename\\n                }\\n                nuaTokensAttached\\n                __typename\\n              }\\n              nuaEligibilityStatus {\\n                edges {\\n                  node {\\n                    id\\n                    index\\n                    roomInformation {\\n                      id\\n                      description\\n                      roomTypeCode\\n                      photoGallery {\\n                        ... on HotelRoomProductImageConnection {\\n                          edges {\\n                            node {\\n                              imageUrls {\\n                                classicHorizontal\\n                                __typename\\n                              }\\n                              __typename\\n                            }\\n                            __typename\\n                          }\\n                          __typename\\n                        }\\n                        __typename\\n                      }\\n                      __typename\\n                    }\\n                    __typename\\n                  }\\n                  __typename\\n                }\\n                __typename\\n              }\\n              __typename\\n            }\\n            reservationRevisionNumber\\n            __typename\\n          }\\n          orderRevisionNumber\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment phoenixAccountDttResponseErrorStatus on ResponseStatus {\\n  httpStatus\\n  code\\n  errors {\\n    code\\n    message\\n    devMessage\\n    __typename\\n  }\\n  warnings {\\n    code\\n    message\\n    __typename\\n  }\\n  __typename\\n}\\n\"}";
  const BUILT_IN_TEMPLATE = {
    url: 'https://www.marriott.com/mi/query/phoenixAccountDttGetNightlyUpgradeAwards',
    method: 'POST',
    headers: {
      'accept': '*/*',
      'accept-language': 'en-US',
      'content-type': 'application/json',
      'apollographql-client-name': 'phoenix_account',
      'apollographql-client-version': 'v1',
      'application-name': 'account',
      'graphql-operation-name': 'phoenixAccountDttGetNightlyUpgradeAwards',
      'graphql-operation-signature': 'bb12d8467d104875afa88fabac6934f84cd912cc510c486b44791544eb80a2cd',
      'graphql-require-safelisting': 'true',
      'uxl-migration-status': btoa(JSON.stringify({ propertyId: 'NYCSW', crsSystem: 'DSP', isDtt: false })),
    },
    body: BUILT_IN_BODY,
    confirmationNumber: '95015195',
    propertyId: 'NYCSW',
  };

  // key: confirmation number (or item id when unknown) -> record
  const found = new Map();
  window.__nuaViewerRecords = found;

  // ---------- Property names (harvested from page responses, else fetched from the hotel page; cached) ----------

  const NAMES_KEY = 'nuaViewer.propertyNames';
  let propertyNames = {};
  try { propertyNames = JSON.parse(localStorage.getItem(NAMES_KEY) || '{}') || {}; } catch {}
  const nameLookups = new Set();
  let nameTimer = null;

  function setPropertyName(code, name) {
    if (!code || !name || typeof name !== 'string') return;
    name = name.trim();
    if (!name || propertyNames[code] === name) return;
    propertyNames[code] = name;
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(propertyNames)); } catch {}
    LOG('Property name', code, '=', name);
    render();
  }

  function propertyName(code) { return (code && propertyNames[code]) || null; }

  // Look for objects that carry both a property code and a name, in any shape Marriott uses.
  function harvestPropertyNames(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(harvestPropertyNames); return; }
    const code = typeof node.id === 'string' && /^[A-Z0-9]{5,7}$/.test(node.id) ? node.id
      : typeof node.marshaCode === 'string' ? node.marshaCode
      : typeof node.propertyId === 'string' ? node.propertyId : null;
    if (code) {
      const name = node.basicInformation?.name || node.name || node.propertyName || node.hotelName || null;
      if (typeof name === 'string' && name.length > 2 && name !== code) setPropertyName(code, name);
    }
    for (const k in node) harvestPropertyNames(node[k]);
  }

  async function lookupPropertyName(code) {
    if (!code || propertyName(code) || nameLookups.has(code)) return;
    nameLookups.add(code);
    try {
      const resp = await origFetch('https://www.marriott.com/hotels/travel/' + code.toLowerCase() + '/', { credentials: 'include' });
      const html = await resp.text();
      let name = null;
      // Prefer schema.org Hotel data, then Open Graph, then the document title.
      for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          const ld = JSON.parse(m[1]);
          const list = Array.isArray(ld) ? ld : [ld];
          for (const o of list) {
            const t = String(o['@type'] || '');
            if (/Hotel|LodgingBusiness|Resort/i.test(t) && o.name) { name = o.name; break; }
          }
        } catch {}
        if (name) break;
      }
      if (!name) { const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i); if (og) name = og[1]; }
      if (!name) { const t = html.match(/<title>([^<]+)<\/title>/i); if (t) name = t[1]; }
      if (name) name = name.replace(/\s*[|\-–]\s*Marriott.*$/i, '').replace(/&amp;/g, '&').trim();
      if (name) setPropertyName(code, name); else LOG('Could not find a name for', code);
    } catch (e) { LOG('Property lookup failed for', code, e); }
  }

  function resolveMissingNames() {
    for (const r of found.values()) if (r.propertyId && hasNua(r) && !propertyName(r.propertyId)) lookupPropertyName(r.propertyId);
  }

  // ---------- Helpers ----------

  function isEmpty(v) { return v === undefined || v === null || v === ''; }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
    if (Array.isArray(h)) { h.forEach(([k, v]) => { out[String(k).toLowerCase()] = v; }); return out; }
    for (const k in h) out[k.toLowerCase()] = h[k];
    return out;
  }

  function uuid() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }

  function urlParam(name) {
    try { return new URL(location.href).searchParams.get(name); } catch { return null; }
  }

  // ---------- Parsing order items (shared by list response, upgrade page response, and replays) ----------

  // A CommerceOrderItem has basicInformation plus nuaInformation.
  function findOrderItems(node, hits) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => findOrderItems(n, hits)); return; }
    if (node.basicInformation && node.nuaInformation) hits.push(node);
    for (const k in node) findOrderItems(node[k], hits);
  }

  function toRecord(item, fallbackConfirmation, fallbackProperty) {
    const bi = item.basicInformation || {};
    const rs = (item.nuaInformation && item.nuaInformation.nuaRequestStatus) || {};
    const confirmationNumber = bi.confirmationNumber || fallbackConfirmation || null;
    const propertyId = (item.property?.id || fallbackProperty || null)?.toUpperCase() || null;
    return {
      key: confirmationNumber || item.id || 'unknown',
      confirmationNumber,
      propertyId,
      startDate: bi.startDate,
      endDate: bi.endDate,
      nights: bi.lengthOfStay,
      tokens: rs.nuaTokensAttached,
      status: rs.status,
      brand: item.property?.basicInformation?.marshaBrandCode,
      crsSystem: item.property?.otherPropertyInformation?.crsSystem,
      rooms: Array.isArray(rs.roomTypes) ? rs.roomTypes.map(rt => ({
        code: rt.roomInformation?.id,
        description: rt.roomInformation?.description,
        photo: rt.roomInformation?.photoGallery?.edges?.[0]?.node?.imageUrls?.classicHorizontal || null,
      })) : null, // null means "this response did not include room types"
      detailLoaded: Array.isArray(rs.roomTypes),
    };
  }

  // Never let an empty value replace a real one.
  function merge(existing, rec) {
    if (!existing) return { ...rec, rooms: rec.rooms || [] };
    const out = { ...existing };
    for (const k of ['confirmationNumber', 'propertyId', 'startDate', 'endDate', 'nights', 'tokens', 'status', 'brand', 'crsSystem']) {
      if (!isEmpty(rec[k])) out[k] = rec[k];
    }
    if (rec.rooms) { out.rooms = rec.rooms; out.detailLoaded = true; }
    return out;
  }

  function ingest(json, source, fallbackConfirmation, fallbackProperty) {
    const items = [];
    findOrderItems(json, items);
    LOG('Response from', source, 'contained', items.length, 'order item(s)');
    let changed = false;
    for (const item of items) {
      const rec = toRecord(item, fallbackConfirmation, fallbackProperty);
      found.set(rec.key, merge(found.get(rec.key), rec));
      changed = true;
    }
    if (changed) render();
    if (IS_SUMMARY_PAGE && changed) scheduleDetailFetch();
    // Give the page's own responses a moment to supply names before fetching hotel pages.
    if (changed) { clearTimeout(nameTimer); nameTimer = setTimeout(resolveMissingNames, 1500); }
    return items.length > 0;
  }

  function hasNua(r) { return Number(r.tokens) > 0 || (r.rooms && r.rooms.length > 0) || !isEmpty(r.status); }

  // ---------- Request template ----------

  const KEEP_HEADERS = ['accept', 'accept-language', 'content-type', 'apollographql-client-name', 'apollographql-client-version',
    'application-name', 'graphql-operation-name', 'graphql-operation-signature', 'graphql-require-safelisting', 'uxl-migration-status'];

  function saveTemplate(url, init, bodyText) {
    const confirmationNumber = urlParam('confirmationNumber');
    const propertyId = urlParam('propertyId');
    if (!confirmationNumber || !bodyText) return;
    const all = headersToObject(init && init.headers);
    const headers = {};
    for (const k of KEEP_HEADERS) if (all[k]) headers[k] = all[k];
    const tpl = { url, method: (init && init.method) || 'POST', headers, body: bodyText, confirmationNumber, propertyId, savedAt: Date.now() };
    try { localStorage.setItem(TEMPLATE_KEY, JSON.stringify(tpl)); LOG('Saved learned request template'); } catch (e) { LOG('Could not save template', e); }
  }

  function loadTemplate() {
    let learned = null;
    try { learned = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || 'null'); } catch {}
    if (learned && learned.body && learned.confirmationNumber) return learned;
    return BUILT_IN_TEMPLATE;
  }

  function replaceValues(node, map) {
    if (Array.isArray(node)) return node.map(n => replaceValues(n, map));
    if (node && typeof node === 'object') {
      const out = {};
      for (const k in node) out[k] = replaceValues(node[k], map);
      return out;
    }
    if (typeof node === 'string' && map.has(node)) return map.get(node);
    return node;
  }

  function buildMigrationHeader(original, propertyId, crsSystem) {
    let obj = {};
    try { obj = JSON.parse(atob(original || '')) || {}; } catch {}
    if (propertyId) obj.propertyId = propertyId;
    if (crsSystem) obj.crsSystem = crsSystem;
    return btoa(JSON.stringify(obj));
  }

  async function fetchNuaFor(tpl, confirmationNumber, propertyId, crsSystem) {
    const map = new Map([[tpl.confirmationNumber, confirmationNumber]]);
    let body;
    try { body = JSON.stringify(replaceValues(JSON.parse(tpl.body), map)); }
    catch { body = tpl.body.split(tpl.confirmationNumber).join(confirmationNumber); }

    const headers = { ...tpl.headers, 'x-request-id': 'phoenix_account-' + uuid() };
    if (headers['uxl-migration-status']) headers['uxl-migration-status'] = buildMigrationHeader(headers['uxl-migration-status'], propertyId, crsSystem);

    const resp = await origFetch(tpl.url, { method: tpl.method, headers, body, credentials: 'include' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  // ---------- List page: fetch room details for reservations that have awards attached ----------

  const queried = new Set();
  let detailTimer = null;
  let detailRunning = false;

  function scheduleDetailFetch() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(runDetailFetch, 300);
  }

  async function runDetailFetch() {
    if (detailRunning) { scheduleDetailFetch(); return; }
    detailRunning = true;
    try {
      const tpl = loadTemplate();
      const pending = [...found.values()].filter(r => r.confirmationNumber && (hasNua(r) || r.forceDetail) && !r.detailLoaded && !queried.has(r.confirmationNumber));
      if (pending.length) setStatus(`Loading Room Selections For ${pending.length} Reservation${pending.length === 1 ? '' : 's'}…`);
      for (const r of pending) {
        queried.add(r.confirmationNumber);
        const attempts = [r.crsSystem || 'DSP', r.crsSystem === 'MARSHA' ? 'DSP' : 'MARSHA'].filter((v, i, a) => a.indexOf(v) === i);
        let ok = false;
        for (const crs of attempts) {
          try {
            const json = await fetchNuaFor(tpl, r.confirmationNumber, r.propertyId, crs);
            if (json && json.errors && !json.data) { LOG('Query error for', r.confirmationNumber, crs, json.errors); continue; }
            ok = ingest(json, 'replay:' + r.confirmationNumber + ':' + crs, r.confirmationNumber, r.propertyId);
            if (ok) break;
          } catch (e) { LOG('Replay failed for', r.confirmationNumber, crs, e); }
        }
        if (!ok) {
          LOG('No room details returned for', r.confirmationNumber);
          const rec = found.get(r.confirmationNumber);
          if (rec) { rec.detailLoaded = true; rec.detailFailed = true; }
        }
      }
      const withNua = [...found.values()].filter(hasNua).length;
      if (IS_DETAIL_PAGE) setStatus('');
      else setStatus(withNua ? '' : (found.size ? 'No Upcoming Reservations Have Nightly Upgrade Awards Attached.' : 'Waiting For Reservation List…'));
    } finally {
      detailRunning = false;
      render();
    }
  }

  // ---------- Network interception ----------

  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const bodyText = init && typeof init.body === 'string' ? init.body : null;
    const opName = headersToObject(init && init.headers)['graphql-operation-name'] || '';
    const isNuaQuery = /GetNightlyUpgradeAwards/i.test(url) || /GetNightlyUpgradeAwards/i.test(opName);
    return origFetch(input, init).then(resp => {
      try {
        resp.clone().text().then(t => {
          if (!t || t.charAt(0) !== '{') return;
          let json; try { json = JSON.parse(t); } catch { return; }
          harvestPropertyNames(json);
          if (t.indexOf('nuaInformation') === -1) return;
          ingest(json, 'fetch:' + url, urlParam('confirmationNumber'), urlParam('propertyId'));
          if (!IS_LIST_PAGE && isNuaQuery) saveTemplate(url, init, bodyText);
        }).catch(() => {});
      } catch {}
      return resp;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (this.responseType !== '' && this.responseType !== 'text') return;
        const t = this.responseText;
        if (!t || t.charAt(0) !== '{') return;
        let json; try { json = JSON.parse(t); } catch { return; }
        harvestPropertyNames(json);
        if (t.indexOf('nuaInformation') === -1) return;
        ingest(json, 'xhr:' + this.responseURL, urlParam('confirmationNumber'), urlParam('propertyId'));
      } catch {}
    });
    return origOpen.apply(this, args);
  };

  document.addEventListener('DOMContentLoaded', () => {
    for (const sc of document.querySelectorAll('script:not([src])')) {
      const t = sc.textContent;
      if (t && t.indexOf('nuaInformation') !== -1) {
        try { ingest(JSON.parse(t), 'inline', urlParam('confirmationNumber'), urlParam('propertyId')); } catch {}
      }
    }
    if (IS_LIST_PAGE && !found.size) setStatus('Waiting For Reservation List…');
    if (IS_DETAIL_PAGE) {
      // Look up this reservation directly; the panel stays hidden unless it has awards attached.
      const cn = urlParam('confirmationNumber');
      const pid = (urlParam('propertyId') || '').toUpperCase() || null;
      if (cn && !found.has(cn)) {
        found.set(cn, { key: cn, confirmationNumber: cn, propertyId: pid, rooms: [], detailLoaded: false, forceDetail: true });
        scheduleDetailFetch();
      }
    }
  }, { once: true });

  // ---------- Rendering ----------

  function fmtDate(iso) {
    if (!iso) return '?';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function imgUrl(path) {
    if (!path) return null;
    if (/^https?:/i.test(path)) return path;
    return IMAGE_BASE + path;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let statusText = '';
  function setStatus(t) { statusText = t; render(); }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    if (!document.body) return null;

    const style = document.createElement('style');
    // Styled to sit alongside Marriott's own cards: white rounded card, near-black text, black pill controls,
    // Bonvoy orange as the single accent, and the page's own typeface (Swiss 721) inherited from the body.
    style.textContent = `
      #${PANEL_ID} { position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; width: 500px; max-width: calc(100vw - 32px);
        max-height: 72vh; overflow: auto; background: #fff; color: #1c1c1c; border: 1px solid #e6e6e6; border-radius: 20px; scrollbar-width: thin;
        box-shadow: 0 6px 24px rgba(0,0,0,.12); font-family: inherit; font-size: 16px; line-height: 1.45; }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} header { display: flex; align-items: center; gap: 12px; padding: 16px 20px; background: #fff;
        border-bottom: 1px solid #e6e6e6; cursor: pointer; position: sticky; top: 0; user-select: none; }
      #${PANEL_ID} .nua-headtext { flex: 1; min-width: 0; }
      #${PANEL_ID} .nua-heading { display: block; white-space: nowrap; font-weight: 700; font-size: 18px; letter-spacing: .01em; color: #1c1c1c; }
      #${PANEL_ID} .nua-sub { display: none; font-size: 16px; color: #707070; font-weight: 400; margin-top: 2px; }
      #${PANEL_ID} .nua-sub.nua-show { display: block; }
      #${PANEL_ID} .nua-count { display: none; min-width: 30px; height: 30px; padding: 0 9px; border-radius: 15px; background: ${ACCENT};
        color: #fff; font-weight: 700; font-size: 16px; line-height: 30px; text-align: center; }
      #${PANEL_ID} .nua-count.nua-show { display: inline-block; }
      #${PANEL_ID} .nua-count.nua-pill { padding: 0 14px; white-space: nowrap; font-weight: 600; flex: none; }
      #${PANEL_ID} .nua-pill-compact, #${PANEL_ID} .nua-pill-mini { display: none; }
      #${PANEL_ID}[data-pill="compact"] .nua-pill-full, #${PANEL_ID}[data-pill="mini"] .nua-pill-full { display: none; }
      #${PANEL_ID}[data-pill="compact"] .nua-pill-compact { display: inline; }
      #${PANEL_ID}[data-pill="mini"] .nua-pill-mini, #${PANEL_ID}[data-pill="tiny"] .nua-pill-mini { display: inline; }
      #${PANEL_ID}[data-pill="tiny"] .nua-pill-full { display: none; }
      #${PANEL_ID} .nua-title-short { display: none; }
      #${PANEL_ID}[data-pill="tiny"] .nua-title-long { display: none; }
      #${PANEL_ID}[data-pill="tiny"] .nua-title-short { display: inline; }
      #${PANEL_ID} .nua-heading { overflow: hidden; text-overflow: ellipsis; }
      #${PANEL_ID} .nua-headtext { overflow: hidden; }
      @media (max-width: 600px) { #${PANEL_ID} { right: 12px; bottom: 12px; max-width: calc(100vw - 24px); } }
      #${PANEL_ID} header button { width: 34px; height: 34px; border-radius: 17px; border: 0; background: #1c1c1c; color: #fff;
        font-size: 22px; line-height: 34px; padding: 0; cursor: pointer; flex: none; }
      #${PANEL_ID} header button:hover { background: #3a3a3a; }
      #${PANEL_ID} .nua-body { padding: 8px 20px 20px; }
      #${PANEL_ID} .nua-status { font-size: 16px; color: #707070; padding: 10px 0; }
      #${PANEL_ID} .nua-stay { padding: 16px 0; border-bottom: 1px solid #e6e6e6; }
      #${PANEL_ID} .nua-stay:last-child { border-bottom: 0; }
      #${PANEL_ID} .nua-title { font-weight: 700; font-size: 18px; line-height: 1.3; margin-bottom: 6px; }
      #${PANEL_ID} .nua-title a { color: #1c1c1c; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
      #${PANEL_ID} .nua-title a:hover { color: ${ACCENT}; }
      #${PANEL_ID} .nua-meta { display: grid; grid-template-columns: auto 1fr; column-gap: 12px; row-gap: 2px; font-size: 16px; margin-bottom: 8px; }
      #${PANEL_ID} .nua-label { color: #707070; }
      #${PANEL_ID} .nua-value { color: #1c1c1c; font-weight: 600; }
      #${PANEL_ID} .nua-requested { color: ${ACCENT}; }
      #${PANEL_ID} .nua-note { font-size: 16px; color: #707070; padding: 8px 0 0; }
      #${PANEL_ID} .nua-room { display: flex; gap: 14px; align-items: center; padding: 10px 0; }
      #${PANEL_ID} .nua-photo { flex: none; display: block; border-radius: 12px; overflow: hidden; }
      #${PANEL_ID} .nua-room img { width: 128px; height: 84px; object-fit: cover; border-radius: 12px; display: block; background: #f4f4f4; transition: transform .15s; }
      #${PANEL_ID} .nua-photo:hover img { transform: scale(1.04); }
      #${PANEL_ID} .nua-rank { display: inline-block; font-size: 16px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
        color: ${ACCENT}; background: #f4f4f4; border-radius: 14px; padding: 2px 12px; margin-bottom: 4px; }
      #${PANEL_ID} .nua-room-name { font-weight: 600; color: #1c1c1c; line-height: 1.3; }
      #${PANEL_ID} .nua-code { font-size: 16px; color: #707070; font-weight: 400; }
      #${PANEL_ID} .nua-conf { font-size: 16px; color: #707070; font-weight: 400; margin-top: 2px; }
      #${PANEL_ID}.nua-collapsed .nua-body { display: none; }
      #${PANEL_ID}.nua-collapsed { width: auto; border-radius: 30px; }
      #${PANEL_ID}.nua-collapsed header { border-bottom: 0; padding: 12px 12px 12px 20px; }
      #${PANEL_ID}.nua-collapsed .nua-headtext { padding-right: 4px; }
    `;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = '<header><span class="nua-headtext"><span class="nua-heading"><span class="nua-title-long">Nightly Upgrade Awards</span><span class="nua-title-short">Upgrade Awards</span></span><span class="nua-sub"></span></span><span class="nua-count" title="Total Awards Attached"></span><button title="Collapse / Expand" aria-label="Collapse or expand">&minus;</button></header><div class="nua-body"></div>';
    panel.querySelector('header').addEventListener('click', () => {
      panel.classList.toggle('nua-collapsed');
      panel.querySelector('header button').textContent = panel.classList.contains('nua-collapsed') ? '+' : '−';
      queueFitPill();
    });
    if (IS_SUMMARY_PAGE) {
      // On the reservation list and detail pages, start collapsed and stay hidden until there is something to show.
      panel.classList.add('nua-collapsed');
      panel.querySelector('header button').textContent = '+';
      panel.style.display = 'none';
    }
    document.body.appendChild(panel);
    return panel;
  }

  // Pick the widest header that fits without clipping the title: "8 Awards | 4 Stays", then "8 | 4", then "8",
  // and finally "8" with the title shortened to "Upgrade Awards".
  function fitPill() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.style.display === 'none') return;
    const headtext = panel.querySelector('.nua-headtext');
    const heading = panel.querySelector('.nua-heading');
    if (!headtext || !heading) return;
    for (const mode of ['full', 'compact', 'mini', 'tiny']) {
      panel.setAttribute('data-pill', mode);
      if (heading.scrollWidth <= headtext.clientWidth + 1) break;
    }
  }
  let fitQueued = false;
  function queueFitPill() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitPill(); });
  }
  window.addEventListener('resize', queueFitPill);

  function nuaPageLink(r) {
    if (!r.confirmationNumber) return null;
    const u = new URL('https://www.marriott.com/loyalty/requestNightlyUpgradeAwards.mi');
    u.searchParams.set('confirmationNumber', r.confirmationNumber);
    u.searchParams.set('tripId', r.confirmationNumber);
    if (r.propertyId) u.searchParams.set('propertyId', r.propertyId);
    u.searchParams.set('nuaUpgrade', 'false');
    return u.href;
  }

  function render() {
    const panel = ensurePanel();
    if (!panel) { document.addEventListener('DOMContentLoaded', render, { once: true }); return; }
    const body = panel.querySelector('.nua-body');
    let recs = [...found.values()];
    if (IS_SUMMARY_PAGE) {
      recs = recs.filter(hasNua).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
      panel.style.display = recs.length ? '' : 'none';
    }
    {
      // Header summary (all pages): total awards in use and the number of stays they are attached to.
      const nuaRecs = recs.filter(hasNua);
      const totalAwards = nuaRecs.reduce((sum, r) => sum + (Number(r.tokens) || 0), 0);
      const count = panel.querySelector('.nua-count');
      const sub = panel.querySelector('.nua-sub');
      const awardsLabel = `${totalAwards} Award${totalAwards === 1 ? '' : 's'}`;
      if (HEADER_STYLE === 'pill') {
        const fullText = `${awardsLabel} | ${nuaRecs.length} Stay${nuaRecs.length === 1 ? '' : 's'}`;
        count.innerHTML = `<span class="nua-pill-full">${esc(fullText)}</span><span class="nua-pill-compact">${totalAwards} | ${nuaRecs.length}</span><span class="nua-pill-mini">${totalAwards}</span>`;
        count.title = fullText;
        count.classList.add('nua-pill');
        count.classList.toggle('nua-show', nuaRecs.length > 0);
        sub.classList.toggle('nua-show', false);
      } else {
        count.textContent = String(totalAwards);
        count.classList.toggle('nua-show', totalAwards > 0);
        sub.textContent = `${awardsLabel} Across ${nuaRecs.length} Reservation${nuaRecs.length === 1 ? '' : 's'}`;
        sub.classList.toggle('nua-show', nuaRecs.length > 0);
      }
    }

    let html = statusText ? `<div class="nua-status">${esc(statusText)}</div>` : '';
    if (!recs.length && !statusText) html += '<div class="nua-status">No NUA Data Captured Yet</div>';

    html += recs.map(r => {
      let rooms;
      if (r.rooms && r.rooms.length) {
        rooms = r.rooms.map((room, i) => `
            <div class="nua-room">
              ${imgUrl(room.photo) ? `<a class="nua-photo" href="${esc(imgUrl(room.photo))}" target="_blank" rel="noopener" title="Open Photo In New Tab"><img src="${esc(imgUrl(room.photo))}" alt=""></a>` : ''}
              <div>
                <div class="nua-rank">Choice ${i + 1}</div>
                <div class="nua-room-name">${esc(room.description)}</div>
                <div class="nua-code">${esc(room.code)}</div>
              </div>
            </div>`).join('');
      } else if (r.detailFailed) {
        rooms = '<div class="nua-note">Room Selections Could Not Be Loaded (See Console)</div>';
      } else if (!r.detailLoaded) {
        rooms = '<div class="nua-note">Loading Room Selections…</div>';
      } else {
        rooms = '<div class="nua-note">No Room Types Requested</div>';
      }
      const link = nuaPageLink(r);
      const name = propertyName(r.propertyId);
      const hotelLabel = name ? `${esc(name)} <span class="nua-code">(${esc(r.propertyId)})</span>` : esc(r.propertyId || 'Reservation');
      const title = IS_SUMMARY_PAGE
        ? `<div class="nua-title">${link ? `<a href="${esc(link)}">` : ''}${hotelLabel}${link ? '</a>' : ''}<div class="nua-conf">Confirmation ${esc(r.confirmationNumber)}</div></div>`
        : (name ? `<div class="nua-title">${hotelLabel}</div>` : '');
      const statusInline = isEmpty(r.status) ? '' : ` <span class="nua-code">&middot;</span> <span class="nua-label">Status:</span> <span class="nua-requested">${esc(r.status)}</span>`;
      return `
        <div class="nua-stay">
          ${title}
          <div class="nua-meta">
            <div class="nua-label">Stay</div><div class="nua-value">${esc(fmtDate(r.startDate))} &ndash; ${esc(fmtDate(r.endDate))}</div>
            <div class="nua-label">Awards Attached</div><div class="nua-value">${esc(isEmpty(r.tokens) ? '?' : r.tokens)}${statusInline}</div>
          </div>
          ${rooms}
        </div>`;
    }).join('');

    body.innerHTML = html;
    queueFitPill();
  }
})();
