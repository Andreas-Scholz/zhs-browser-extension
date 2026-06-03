(function () {
  'use strict';

  // Unified extension API: Firefox exposes `browser`, Chrome exposes `chrome`.
  const _browser = globalThis.browser ?? globalThis.chrome;

  // Locale derived from the URL path (/de/, /en/, …).
  // Falls back to the browser UI language when the segment doesn't look like a locale.
  const _pageSeg  = location.pathname.split('/')[1] ?? '';
  const UI_LOCALE = /^[a-z]{2,3}$/.test(_pageSeg) ? _pageSeg : _browser.i18n.getUILanguage();

  // _messages is populated by loadPageLocale() in init() before any UI is built.
  // Until then t() falls back to _browser.i18n.getMessage() (browser UI language).
  let _messages = {};
  const t = (key, subs) => {
    const entry = _messages[key];
    if (entry) {
      let msg = entry.message;
      if (subs) {
        const arr = Array.isArray(subs) ? subs : [subs];
        arr.forEach((s, i) => { msg = msg.replaceAll(`$${i + 1}`, s); });
      }
      return msg;
    }
    return _browser.i18n.getMessage(key, subs);
  };

  const GRAPHQL_URL = 'https://kurse.zhs-muenchen.de/api/query';
  const DAYS_AHEAD = 7;

  const SLOTS_QUERY = `
query List_product_slots($productID: UUID!, $input: BookingSlotsInput!) {
  booking_slots(product_id: $productID, input: $input) {
    start
    end
    booking_period_start
    availability
    already_booked
    already_in_cart
    blocked_by_resource
  }
}`;

  // Minimal response — we only need to know whether the mutation succeeded.
  const ADD_TO_CART_MUTATION = `
mutation Add_slot_product_to_cart($input: AddSlotProductToCartInput!) {
  add_slot_product_to_cart(input: $input) { id }
}`;

  // ---------------------------------------------------------------------------
  // GraphQL helpers
  // ---------------------------------------------------------------------------

  async function gql(query, variables = {}) {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ query, variables })
    });
    return res.json();
  }

  async function fetchSlots(productId, start, end) {
    const json = await gql(SLOTS_QUERY, {
      productID: productId,
      input: { start: start.toISOString(), end: end.toISOString() }
    });
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data?.booking_slots ?? [];
  }

  async function addToCart(productId, slotStart, slotEnd) {
    const json = await gql(ADD_TO_CART_MUTATION, {
      input: { parent_id: productId, slot_start: slotStart, slot_end: slotEnd }
    });
    if (json.errors) throw new Error(json.errors[0].message);
  }

  // Holds the latest silentRefresh callback so visibilitychange can invoke it.
  let currentOnCartAdd = null;

  // ---------------------------------------------------------------------------
  // Date / time utilities
  // ---------------------------------------------------------------------------

  function toDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function toTimeStr(isoString) {
    return new Date(isoString).toLocaleTimeString(UI_LOCALE, {
      hour: '2-digit', minute: '2-digit'
    });
  }

  function slotStatus(slot, now) {
    if (new Date(slot.booking_period_start) > now) return 'not_yet_bookable';
    if (new Date(slot.end) <= now) return 'expired';
    if (slot.already_booked > 0) return 'already_booked';
    if (slot.already_in_cart > 0) return 'in_cart';
    if (slot.blocked_by_resource || slot.availability < 1) return 'booked_out';
    return 'available';
  }

  // Worst-first ordering: lower index = worse outcome for the combined slot pair.
  const STATUS_RANK = ['expired', 'booked_out', 'not_yet_bookable', 'already_booked', 'in_cart', 'available'];

  function combineStatus(s1, s2) {
    return STATUS_RANK[Math.min(STATUS_RANK.indexOf(s1), STATUS_RANK.indexOf(s2))];
  }

  const _STATUS_KEYS = {
    available:        'statusAvailable',
    booked_out:       'statusBookedOut',
    already_booked:   'statusAlreadyBooked',
    in_cart:          'statusInCart',
    not_yet_bookable: 'statusNotYetBookable',
    expired:          'statusExpired',
  };
  // Function (not object) so translations are resolved lazily after loadPageLocale() runs.
  const statusLabel = status => t(_STATUS_KEYS[status] ?? status);

  // ---------------------------------------------------------------------------
  // Build grid data
  // ---------------------------------------------------------------------------

  function buildGrid(allData, durationHours) {
    const now = new Date(); // computed once, passed into slotStatus

    // Build slot index: productId → Map(startMs → slot)
    const slotIndex = new Map();
    for (const { product, slots } of allData) {
      const byTime = new Map();
      for (const slot of slots) byTime.set(new Date(slot.start).getTime(), slot);
      slotIndex.set(product.id, byTime);
    }

    const grid = new Map();
    const daysSet = new Set();
    const timesMap = new Map(); // "HH:MM" UTC (sort key) → displayLabel

    for (const { product, slots } of allData) {
      for (const slot of slots) {
        let slot2 = null;
        const startMs = new Date(slot.start).getTime();
        if (durationHours === 2) {
          slot2 = slotIndex.get(product.id)?.get(startMs + 3_600_000) ?? null;
          if (!slot2) continue;
        }

        const dayKey = toDateKey(new Date(slot.start));
        const startStr = toTimeStr(slot.start);
        const label = `${startStr}–${toTimeStr(durationHours === 2 ? slot2.end : slot.end)}`;

        daysSet.add(dayKey);
        timesMap.set(slot.start.slice(11, 16), label); // "HH:MM" deduplicates across days

        if (!grid.has(dayKey)) grid.set(dayKey, new Map());
        const dayMap = grid.get(dayKey);
        if (!dayMap.has(label)) dayMap.set(label, { available: 0, total: 0, courts: [] });
        const cell = dayMap.get(label);

        const s1 = slotStatus(slot, now);
        const status = durationHours === 2 ? combineStatus(s1, slotStatus(slot2, now)) : s1;

        cell.total++;
        if (status === 'available') cell.available++;
        cell.courts.push({ product, slot, slot2, status });
      }
    }

    return {
      days:  Array.from(daysSet).sort(),
      times: Array.from(timesMap.keys()).sort().map(k => timesMap.get(k)),
      grid,
    };
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  function createPanel(offerName) {
    const panel = document.createElement('div');
    panel.id = 'zhs-overview-panel';
    // Static structure only — no user data interpolated into innerHTML.
    // Translation strings from t() are controlled values, safe for innerHTML.
    panel.innerHTML = `
      <div class="zhs-header">
        <div class="zhs-header-title">
          <span class="zhs-offer-name"></span>
        </div>
        <div class="zhs-header-actions">
          <div class="zhs-dur-toggle" role="group" aria-label="${t('durToggleLabel')}">
            <button class="zhs-dur-btn" data-dur="1">${t('duration1h')}</button>
            <button class="zhs-dur-btn zhs-dur-active" data-dur="2">${t('duration2h')}</button>
          </div>
          <button class="zhs-btn-icon" id="zhs-refresh-btn" title="${t('refreshTitle')}">↻</button>
          <button class="zhs-btn-icon" id="zhs-collapse-btn" title="${t('collapseTitle')}">▼</button>
        </div>
      </div>
      <div class="zhs-body" id="zhs-body">
        <div class="zhs-loading" id="zhs-loading">
          <div class="zhs-spinner"></div>
          <span>${t('loadingText')}</span>
        </div>
        <div id="zhs-content"></div>
      </div>
    `;
    // Set user-controlled string safely via textContent.
    panel.querySelector('.zhs-offer-name').textContent = `${offerName} — ${t('overviewSuffix')}`;

    panel.querySelector('#zhs-collapse-btn').addEventListener('click', () => {
      const body = panel.querySelector('#zhs-body');
      const btn  = panel.querySelector('#zhs-collapse-btn');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      btn.textContent = collapsed ? '▼' : '▶';
      btn.title = collapsed ? t('collapseTitle') : t('expandTitle');
    });

    return panel;
  }

  // ---------------------------------------------------------------------------
  // Grid rendering
  // ---------------------------------------------------------------------------

  const cellDataMap = new WeakMap();

  function renderGrid(grid, days, times) {
    const wrapper = document.createElement('div');

    const legend = document.createElement('div');
    legend.className = 'zhs-legend';
    legend.innerHTML = `
      <span class="zhs-dot zhs-avail"></span>${t('legendAvailable')} &ensp;
      <span class="zhs-dot zhs-few"></span>${t('legendFew')} &ensp;
      <span class="zhs-dot zhs-full"></span>${t('legendFull')} &ensp;
      <span class="zhs-dot zhs-past"></span>${t('legendPast')} &ensp;
      <span class="zhs-dot zhs-soon"></span>${t('legendSoon')} &ensp;
      <span class="zhs-swatch zhs-swatch-booked"></span>${t('legendBooked')} &ensp;
      <span class="zhs-swatch zhs-swatch-cart"></span>${t('legendCart')}
    `;
    wrapper.appendChild(legend);

    const scroller = document.createElement('div');
    scroller.className = 'zhs-scroll';

    const table = document.createElement('table');
    table.className = 'zhs-table';

    // Header row
    const thead = table.createTHead();
    const headerRow = thead.insertRow();
    const thTime = document.createElement('th');
    thTime.className = 'zhs-col-time';
    thTime.textContent = t('timeColHeader');
    headerRow.appendChild(thTime);

    const today = toDateKey(new Date());
    for (const day of days) {
      const th = document.createElement('th');
      const d = new Date(day + 'T12:00:00');
      th.className = 'zhs-col-day' + (day === today ? ' zhs-today' : '');
      // toLocaleDateString is browser-generated, safe for innerHTML.
      th.innerHTML =
        `<div class="zhs-wd">${d.toLocaleDateString(UI_LOCALE, { weekday: 'short' })}</div>` +
        `<div class="zhs-dm">${d.toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'short' })}</div>`;
      headerRow.appendChild(th);
    }

    // Body rows
    const tbody = table.createTBody();
    for (const timeLabel of times) {
      const tr = tbody.insertRow();
      const tdTime = tr.insertCell();
      tdTime.className = 'zhs-time';
      tdTime.textContent = timeLabel; // toLocaleTimeString output, but use textContent anyway

      for (const day of days) {
        const cell = grid.get(day)?.get(timeLabel);
        const td = tr.insertCell();
        td.className = 'zhs-cell';

        if (!cell) {
          td.classList.add('zhs-past');
          td.textContent = '—';
          continue;
        }

        const { available, total, courts } = cell;
        const allExpired = courts.every(c => c.status === 'expired');
        const allNotYet  = courts.every(c => c.status === 'not_yet_bookable');

        if (allExpired) {
          td.classList.add('zhs-past');
          td.textContent = '—';
          continue;
        }

        if (allNotYet) {
          td.classList.add('zhs-soon');
          const bookingStart = new Date(courts[0].slot.booking_period_start);
          td.textContent = `${t('bookableFromPrefix')} ${bookingStart.toLocaleString(UI_LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
          td.title = `${t('bookableFromPrefix')} ${bookingStart.toLocaleString(UI_LOCALE)}`;
          continue;
        }

        // In 2h mode both hours must match; in 1h mode slot2 is null → condition is vacuously true.
        const nBooked = courts.filter(c =>
          c.slot.already_booked > 0 && (c.slot2 == null || c.slot2.already_booked > 0)
        ).length;
        const nInCart = courts.filter(c =>
          c.slot.already_in_cart > 0 && (c.slot2 == null || c.slot2.already_in_cart > 0)
        ).length;

        if (available === 0)                          td.classList.add('zhs-full');
        else if (available <= Math.ceil(total / 3))   td.classList.add('zhs-few');
        else                                          td.classList.add('zhs-avail');

        if (nBooked)       td.classList.add('zhs-has-booked');
        else if (nInCart)  td.classList.add('zhs-has-cart');

        const suffix = nBooked  ? t('cellSuffixBooked', [String(nBooked)])
                     : nInCart  ? t('cellSuffixCart',   [String(nInCart)])
                     : '';
        td.textContent = `${available}/${total}`;
        td.title = t('cellTooltip', [String(available), String(total)]) + suffix;
        td.style.cursor = 'pointer';
        cellDataMap.set(td, { day, timeLabel, courts });
      }
    }

    table.appendChild(tbody);
    scroller.appendChild(table);
    wrapper.appendChild(scroller);
    return wrapper;
  }

  // ---------------------------------------------------------------------------
  // Detail popup
  // ---------------------------------------------------------------------------

  let activePopup = null;
  let activeCloseHandler = null;

  function closePopup() {
    activePopup?.remove();
    activePopup = null;
    if (activeCloseHandler) {
      document.removeEventListener('click', activeCloseHandler, true);
      document.removeEventListener('keydown', activeCloseHandler, true);
      activeCloseHandler = null;
    }
  }

  function showDetailPopup(anchorEl, { day, timeLabel, courts }, onCartAdd) {
    closePopup();

    const d = new Date(day + 'T12:00:00');
    const dayTitle = d.toLocaleDateString(UI_LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

    const popup = document.createElement('div');
    popup.className = 'zhs-popup';

    // Header — both dayTitle and timeLabel are locale-generated strings, safe.
    const head = document.createElement('div');
    head.className = 'zhs-popup-head';
    head.innerHTML = `
      <div>
        <div class="zhs-popup-day">${dayTitle}</div>
        <div class="zhs-popup-time">${timeLabel}</div>
      </div>
      <button class="zhs-popup-close" title="${t('closeTitle')}">✕</button>
    `;
    popup.appendChild(head);

    const courtsList = document.createElement('div');
    courtsList.className = 'zhs-popup-courts';

    const sorted = [...courts]
      .filter(c => c.status !== 'expired')
      .sort((a, b) => a.product.name.localeCompare(b.product.name, UI_LOCALE, { numeric: true }));

    for (const { product, slot, slot2, status } of sorted) {
      const item = document.createElement('div');
      item.className = `zhs-court zhs-s-${status}`;
      item.dataset.productId  = product.id;
      item.dataset.slotStart  = slot.start;
      item.dataset.slotEnd    = slot.end;
      if (slot2) {
        item.dataset.slotStart2 = slot2.start;
        item.dataset.slotEnd2   = slot2.end;
      }

      // Build court item with DOM methods — product.name is untrusted API data.
      const info = document.createElement('div');
      info.className = 'zhs-court-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'zhs-court-name';
      nameEl.textContent = product.name;

      const statusEl = document.createElement('div');
      statusEl.className = 'zhs-court-status';
      statusEl.textContent = statusLabel(status);

      info.append(nameEl, statusEl);
      item.appendChild(info);

      if (status === 'available') {
        const btn = document.createElement('button');
        btn.className = 'zhs-cart-btn';
        btn.textContent = t('bookBtn');
        item.appendChild(btn);
      }

      courtsList.appendChild(item);
    }

    popup.appendChild(courtsList);

    popup.addEventListener('click', async e => {
      if (e.target.classList.contains('zhs-popup-close')) { closePopup(); return; }

      const btn = e.target.closest('.zhs-cart-btn');
      if (!btn) return;

      const courtItem = btn.closest('.zhs-court');
      const { productId, slotStart, slotEnd, slotStart2, slotEnd2 } = courtItem.dataset;

      btn.disabled = true;
      btn.textContent = '…';

      try {
        await addToCart(productId, slotStart, slotEnd);
        if (slotStart2) await addToCart(productId, slotStart2, slotEnd2);

        btn.remove();
        courtItem.className = 'zhs-court zhs-s-in_cart';
        courtItem.querySelector('.zhs-court-status').textContent = statusLabel('in_cart');

        const stillAvail = courtsList.querySelectorAll('.zhs-s-available').length;
        head.querySelector('.zhs-popup-time').textContent =
          `${timeLabel} · ${t('popupStillAvail', [String(stillAvail), String(sorted.length)])}`;

        onCartAdd?.();
      } catch (err) {
        btn.textContent = t('bookBtnError');
        btn.disabled = false;
        btn.title = err.message;
      }
    });

    document.body.appendChild(popup);
    activePopup = popup;

    // Position: prefer below cell, fall back to above, clamp to viewport.
    const rect = anchorEl.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(rect.left, window.innerWidth - popup.offsetWidth - margin);
    left = Math.max(left, margin);
    let top = rect.bottom + 6;
    if (top + popup.offsetHeight > window.innerHeight - margin) {
      top = rect.top - popup.offsetHeight - 6;
    }
    popup.style.left = `${left}px`;
    popup.style.top  = `${Math.max(margin, top)}px`;

    activeCloseHandler = e => {
      if (e.type === 'keydown') { if (e.key === 'Escape') closePopup(); return; }
      if (!popup.contains(e.target) && e.target !== anchorEl) closePopup();
    };
    setTimeout(() => {
      document.addEventListener('click', activeCloseHandler, true);
      document.addEventListener('keydown', activeCloseHandler, true);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  // The page uses Alpine.js, which renders #product_offer_details asynchronously
  // after load. Poll via MutationObserver rather than reading synchronously.
  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const ob = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { ob.disconnect(); resolve(found); }
      });
      ob.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { ob.disconnect(); reject(); }, timeout);
    });
  }

  async function loadPageLocale() {
    if (!_pageSeg) return;
    try {
      const res = await fetch(_browser.runtime.getURL(`_locales/${_pageSeg}/messages.json`));
      if (res.ok) _messages = await res.json();
    } catch { /* fall back to _browser.i18n */ }
  }

  let activeLoadAbort = null;

  async function loadAndRender(products, contentEl, loadingEl, durationHours, refreshBtn) {
    // Cancel any in-flight load so its result never overwrites the new one.
    activeLoadAbort?.abort();
    const aborter = new AbortController();
    activeLoadAbort = aborter;

    if (refreshBtn) { refreshBtn.textContent = '↻'; refreshBtn.disabled = true; }
    loadingEl.style.display = 'flex';
    contentEl.innerHTML = '';
    closePopup();

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // +1 day so 2h slots at the boundary of day 7 can find their second hour.
    const endDate = new Date(startOfToday.getTime() + (DAYS_AHEAD + 1) * 86_400_000);

    function fetchAllSlots() {
      return Promise.all(products.map(async p => ({
        product: p,
        slots: await fetchSlots(p.id, startOfToday, endDate)
      })));
    }

    let onCartAdd;

    async function silentRefresh() {
      if (aborter.signal.aborted) return;
      try {
        const allData = await fetchAllSlots();
        if (aborter.signal.aborted) return;
        const { days, times, grid } = buildGrid(allData, durationHours);
        const gridEl = renderGrid(grid, days, times);
        attachTableClicks(gridEl, onCartAdd);
        contentEl.innerHTML = '';
        contentEl.appendChild(gridEl);
      } catch { /* keep old grid visible on error */ }
    }

    onCartAdd = silentRefresh;
    currentOnCartAdd = onCartAdd;

    try {
      const allData = await fetchAllSlots();
      if (aborter.signal.aborted) return;

      loadingEl.style.display = 'none';
      if (refreshBtn) { refreshBtn.textContent = '↻'; refreshBtn.disabled = false; }

      const { days, times, grid } = buildGrid(allData, durationHours);
      if (!days.length) {
        contentEl.textContent = t('noSlots');
        return;
      }
      const gridEl = renderGrid(grid, days, times);
      attachTableClicks(gridEl, onCartAdd);
      contentEl.appendChild(gridEl);

    } catch (err) {
      if (aborter.signal.aborted) return;
      loadingEl.style.display = 'none';
      if (refreshBtn) { refreshBtn.textContent = '↻'; refreshBtn.disabled = false; }
      contentEl.textContent = t('errorLoading', [err.message]);
    }
  }

  function attachTableClicks(tableWrapper, onCartAdd) {
    tableWrapper.addEventListener('click', e => {
      const cell = e.target.closest('.zhs-cell');
      if (!cell || !cellDataMap.has(cell)) return;
      showDetailPopup(cell, cellDataMap.get(cell), onCartAdd);
    });
  }

  async function init() {
    try { await waitForElement('#product_offer_details'); }
    catch { return; }

    await loadPageLocale();

    const productOffer = getProductOfferFromPage();
    if (!productOffer?.products?.length) return;

    const { products, name: offerName = t('defaultOfferName') } = productOffer;

    const detailsEl = document.getElementById('product_offer_details');
    const wrapper = detailsEl.closest('.shell-mx-auto, main, #shell');
    if (!wrapper) return;

    const panel = createPanel(offerName);
    wrapper.insertBefore(panel, wrapper.firstChild);

    const loadingEl  = panel.querySelector('#zhs-loading');
    const contentEl  = panel.querySelector('#zhs-content');
    const refreshBtn = panel.querySelector('#zhs-refresh-btn');
    let currentDuration = 2;

    panel.querySelectorAll('.zhs-dur-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dur = Number(btn.dataset.dur);
        if (dur === currentDuration) return;
        currentDuration = dur;
        panel.querySelectorAll('.zhs-dur-btn').forEach(b =>
          b.classList.toggle('zhs-dur-active', b === btn)
        );
        loadAndRender(products, contentEl, loadingEl, currentDuration, refreshBtn);
      });
    });

    refreshBtn.addEventListener('click', () => {
      loadAndRender(products, contentEl, loadingEl, currentDuration, refreshBtn);
    });

    loadAndRender(products, contentEl, loadingEl, currentDuration, refreshBtn);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) currentOnCartAdd?.();
    });
  }

  function getProductOfferFromPage() {
    const el = document.getElementById('product_offer_details');
    if (!el) return null;
    try {
      return JSON.parse(el.getAttribute('x-data'))?.data?.product_offer ?? null;
    } catch {
      return null;
    }
  }

  // run_at: document_idle guarantees the DOM is ready before this script runs.
  init();
})();
