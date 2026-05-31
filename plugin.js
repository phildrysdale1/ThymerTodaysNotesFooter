// ==Plugin==
// name: Today's Notes
// description: Footer on journal entries showing records whose date field matches
// icon: ti-calendar-stats
// ==/Plugin==



// @generated BEGIN thymer-plugin-settings (source: plugins/public repo/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Create dedupe: Web Locks + **per-workspace** localStorage lease/recent-create keys (workspaceGuid from
 * `data.getActiveUsers()[0]`), plus abort if an exact-named Plugin Backend collection already exists.
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** In-flight dedupe: parallel plugin `init()` calls share one `getAllCollections()` snapshot. */
  const DATA_GET_ALL_P = '__thymerExtGetAllCollectionsInflight';

  function preferDeferredHeavyWork() {
    try {
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
    } catch (_) {}
    try {
      return Number(navigator?.maxTouchPoints) > 0;
    } catch (_) {}
    return false;
  }

  const MOBILE_GRACE_UNTIL_KEY = '__thymerExtMobileGraceUntil';
  const MOBILE_HIDDEN_AT_KEY = '__thymerExtMobileHiddenAt';
  const MOBILE_INTERACT_THROTTLE_AT_KEY = '__thymerExtMobileInteractThrottleAt';
  /** Pause footer scans / Path B until host sidebar is up — keep short so navigation is not blocked for ~2 min. */
  const MOBILE_GRACE_MS = 45000;
  const MOBILE_RESUME_GRACE_MS = 35000;
  const MOBILE_RESUME_AWAY_MS = 15000;
  /** Interaction only pauses the heavy-work queue briefly — do not extend MOBILE_GRACE (that delayed page change until ~2 min). */
  const MOBILE_HEAVY_PAUSE_ON_INTERACT_MS = 10000;
  const MOBILE_INTERACTION_THROTTLE_MS = 2500;
  const HEAVY_QUEUE_PAUSED_UNTIL_KEY = '__thymerExtHeavyQueuePausedUntil';

  // Heavy work scheduler: many plugins "wake up" together after mobile grace ends.
  // Running them concurrently causes long-task storms that block navigation.
  const HEAVY_Q_KEY = '__thymerExtHeavyWorkQueue';
  const HEAVY_BUSY_KEY = '__thymerExtHeavyWorkBusy';

  function ensureMobileLoadGraceStarted(extraMs) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (extraMs > 0 ? extraMs : MOBILE_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function inMobileLoadGrace() {
    if (!preferDeferredHeavyWork()) return false;
    try {
      return Date.now() < (g[MOBILE_GRACE_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  function bumpMobileLoadGrace(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_RESUME_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function installMobileResumeGraceListener() {
    if (g.__thymerExtMobileGraceListenerInstalled) return;
    g.__thymerExtMobileGraceListenerInstalled = true;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener(
      'visibilitychange',
      () => {
        try {
          if (document.visibilityState === 'hidden') {
            g[MOBILE_HIDDEN_AT_KEY] = Date.now();
          } else if (document.visibilityState === 'visible') {
            const hiddenAt = g[MOBILE_HIDDEN_AT_KEY] || 0;
            const away = hiddenAt ? Date.now() - hiddenAt : 0;
            if (away >= MOBILE_RESUME_AWAY_MS) bumpMobileLoadGrace(MOBILE_RESUME_GRACE_MS);
          }
        } catch (_) {}
      },
      { passive: true }
    );
  }

  function pauseHeavyWorkQueue(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
    try {
      if (!g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] < until) {
        g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function isHeavyWorkQueuePaused() {
    try {
      return Date.now() < (g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  /** True during startup window: skip footer mount / panel scans so page navigation stays responsive. */
  function shouldDeferPanelFooterWork() {
    return inMobileLoadGrace();
  }

  function installMobileInteractionGraceListener() {
    if (g.__thymerExtMobileInteractGraceInstalled) return;
    g.__thymerExtMobileInteractGraceInstalled = true;
    if (!preferDeferredHeavyWork()) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

    const onInteract = () => {
      try {
        const now = Date.now();
        const prev = g[MOBILE_INTERACT_THROTTLE_AT_KEY] || 0;
        if (now - prev < MOBILE_INTERACTION_THROTTLE_MS) return;
        g[MOBILE_INTERACT_THROTTLE_AT_KEY] = now;
        pauseHeavyWorkQueue(MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
      } catch (_) {}
    };

    for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
      try {
        document.addEventListener(ev, onInteract, { passive: true, capture: true });
      } catch (_) {}
    }
  }

  async function yieldToHostOneTick() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        setTimeout(r, 0);
      }
    });
  }

  async function runNextHeavyWork() {
    if (g[HEAVY_BUSY_KEY]) return;
    const q = g[HEAVY_Q_KEY];
    if (!Array.isArray(q) || q.length === 0) return;
    g[HEAVY_BUSY_KEY] = true;
    try {
      while (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        if (inMobileLoadGrace() || isHeavyWorkQueuePaused()) break;
        const job = g[HEAVY_Q_KEY].shift();
        if (!job || typeof job.run !== 'function') continue;
        try {
          await yieldToHostOneTick();
        } catch (_) {}
        // Prefer running during idle; fallback is still serialized.
        try {
          if (typeof requestIdleCallback === 'function') {
            await new Promise((resolve) => requestIdleCallback(resolve, { timeout: 1200 }));
          }
        } catch (_) {}
        try {
          await job.run();
        } catch (_) {}
        // Yield after each heavy job so navigation events can be processed.
        try {
          await yieldToHostOneTick();
        } catch (_) {}
      }
    } finally {
      g[HEAVY_BUSY_KEY] = false;
      // If we stopped due to grace, try again later.
      if (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        setTimeout(() => runNextHeavyWork(), 1500);
      }
    }
  }

  function enqueueHeavyWork(run, opts) {
    if (typeof run !== 'function') return;
    if (!g[HEAVY_Q_KEY]) g[HEAVY_Q_KEY] = [];
    const delayMs = Math.max(0, Number(opts?.delayMs) || 0);
    const push = () => {
      try {
        g[HEAVY_Q_KEY].push({ run });
      } catch (_) {}
      setTimeout(() => runNextHeavyWork(), 0);
    };
    if (delayMs > 0) setTimeout(push, delayMs);
    else push();
  }

  async function yieldToHostBeforePathB() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        r();
      }
    });
    await new Promise((resolve) => {
      try {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(), {
            timeout: preferDeferredHeavyWork() ? 8000 : 1500,
          });
        } else {
          setTimeout(resolve, preferDeferredHeavyWork() ? 48 : 16);
        }
      } catch (_) {
        setTimeout(resolve, 32);
      }
    });
  }

  async function getAllCollectionsDeduped(data) {
    if (!data || typeof data.getAllCollections !== 'function') return [];
    const inflight = data[DATA_GET_ALL_P];
    if (inflight && typeof inflight.then === 'function') {
      try {
        return await inflight;
      } catch (_) {
        // fall through to fresh fetch
      }
    }
    const p = Promise.resolve()
      .then(() => data.getAllCollections())
      .then((all) => (Array.isArray(all) ? all : []))
      .finally(() => {
        try {
          if (data[DATA_GET_ALL_P] === p) delete data[DATA_GET_ALL_P];
        } catch (_) {}
      });
    data[DATA_GET_ALL_P] = p;
    return p;
  }

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    let slugRegisterSavedOk = false;
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
        else slugRegisterSavedOk = true;
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    if (slugRegisterSavedOk) await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/public repo/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      if (changed) await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  /** Parse ISO-ish timestamps for vault row scoring (duplicates: pick freshest, not first in list). */
  function parseVaultIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function vaultRowFreshnessScore(r) {
    let score = 0;
    let raw = '';
    try {
      raw = rowField(r, 'settings_json');
    } catch (_) {}
    if (raw && String(raw).trim()) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.updatedAt === 'string') {
          const ms = parseVaultIsoMs(j.updatedAt);
          if (ms > score) score = ms;
        }
      } catch (_) {}
    }
    try {
      const ua = rowField(r, 'updated_at');
      if (ua) {
        const ms = parseVaultIsoMs(ua);
        if (ms > score) score = ms;
      }
    } catch (_) {}
    return score;
  }

  function settingsJsonPayloadLen(r) {
    try {
      return String(rowField(r, 'settings_json') || '').length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Prefer the **newest** vault row when duplicates exist (same `plugin_id`, multiple vault-shaped rows).
   * Previously the first list match could be stale while a newer row held the real payload.
   */
  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    let best = null;
    let bestScore = -1;
    for (const x of records) {
      if (!isVaultRow(x, pluginId)) continue;
      const sc = vaultRowFreshnessScore(x);
      if (sc > bestScore) {
        bestScore = sc;
        best = x;
      } else if (sc === bestScore && best) {
        const lenX = settingsJsonPayloadLen(x);
        const lenB = settingsJsonPayloadLen(best);
        if (lenX > lenB) best = x;
      }
    }
    return best;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  /** Unscoped keys (legacy); runtime uses {@link scopedPbLsKey} per workspace. */
  const LS_CREATE_LEASE_BASE = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_BASE = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_BASE = 'thymerext_plugin_backend_recent_create_attempt_v1';

  function workspaceSlugFromData(data) {
    try {
      const u = data && typeof data.getActiveUsers === 'function' ? data.getActiveUsers() : null;
      const g = u && u[0] && u[0].workspaceGuid;
      const s = g != null ? String(g).trim() : '';
      if (s) return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120);
    } catch (_) {}
    return '_unknown_ws';
  }

  function scopedPbLsKey(base, data) {
    return `${base}__${workspaceSlugFromData(data)}`;
  }

  /** Count collections whose sidebar/title name is exactly Plugin Backend (or legacy). */
  async function countExactPluginBackendNamedCollections(data) {
    let all;
    try {
      all = await getAllCollectionsDeduped(data);
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const c of all) {
      try {
        const nm = collectionDisplayName(c);
        if (nm === COL_NAME || nm === COL_NAME_LEGACY) n += 1;
      } catch (_) {}
    }
    return n;
  }

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * Lease keys are **per workspace** so switching workspaces does not inherit another vault’s lease / cooldown.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs, data) {
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) {
      if (locksOk) return noop;
      if (DEBUG_COLLECTIONS) {
        dlogPathB('lease_denied_no_localstorage_no_locks', { ws: workspaceSlugFromData(data) });
      }
      return { denied: true, release() {} };
    }
    const leaseKey = scopedPbLsKey(LS_CREATE_LEASE_BASE, data);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(leaseKey, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(leaseKey) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention, leaseKey });
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention, leaseKey });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(leaseKey);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  function pickCollFromAll(all) {
    try {
      const pick = (allIn) => {
        const list = Array.isArray(allIn) ? allIn : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  function hasPluginBackendInAll(all) {
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  async function findColl(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return pickCollFromAll(all);
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return hasPluginBackendInAll(all);
    } catch (_) {
      return false;
    }
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';
  /** Per-workspace: Plugin Backend already ensured — skip repeat bodies (avoids getAllCollections / lock storms). */
  const WS_ENSURE_OK_MAP = '__thymerExtPbWorkspaceEnsureOkMap_v1';

  function markWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      if (!h[WS_ENSURE_OK_MAP] || typeof h[WS_ENSURE_OK_MAP] !== 'object') h[WS_ENSURE_OK_MAP] = Object.create(null);
      h[WS_ENSURE_OK_MAP][slug] = true;
    } catch (_) {}
  }

  function isWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      const m = h[WS_ENSURE_OK_MAP];
      return !!(m && m[slug]);
    } catch (_) {
      return false;
    }
  }

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (data && isWorkspacePluginBackendEnsureDone(data)) return;
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await getAllCollectionsDeduped(data);
          const list = Array.isArray(a) ? a : [];
          const collNames = list.map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
          const dupExact = list.filter((c) => {
            try {
              const nm = collectionDisplayName(c);
              return nm === COL_NAME || nm === COL_NAME_LEGACY;
            } catch (__) {
              return false;
            }
          });
          if (dupExact.length > 1) {
            dlogPathB('duplicate_plugin_backend_named_collections', {
              count: dupExact.length,
              guids: dupExact.map((c) => {
                try {
                  return c.getGuid?.() || null;
                } catch (__) {
                  return null;
                }
              }),
              doc: 'docs/PLUGIN_BACKEND_DUPLICATE_HYGIENE.md',
            });
          }
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      const markPbOk = () => markWorkspacePluginBackendEnsureDone(data);
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let allAttempt;
        try {
          allAttempt = await getAllCollectionsDeduped(data);
        } catch (_) {
          allAttempt = null;
        }
        if (allAttempt != null) {
          existing = pickCollFromAll(allAttempt);
          if (existing) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allAttempt)) {
            markPbOk();
            return;
          }
        } else {
          existing = await findColl(data);
          if (existing) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      let allPost;
      try {
        allPost = await getAllCollectionsDeduped(data);
      } catch (_) {
        allPost = null;
      }
      if (allPost != null) {
        existing = pickCollFromAll(allPost);
        if (existing) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allPost)) {
          markPbOk();
          return;
        }
      } else {
        existing = await findColl(data);
        if (existing) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      let allAfterWait;
      try {
        allAfterWait = await getAllCollectionsDeduped(data);
      } catch (_) {
        allAfterWait = null;
      }
      if (allAfterWait != null) {
        if (pickCollFromAll(allAfterWait)) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allAfterWait)) {
          markPbOk();
          return;
        }
      } else {
        if (await findColl(data)) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await getAllCollectionsDeduped(data);
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await getAllCollectionsDeduped(data);
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          let allPre;
          try {
            allPre = await getAllCollectionsDeduped(data);
          } catch (_) {
            allPre = null;
          }
          if (allPre != null) {
            if (pickCollFromAll(allPre)) {
              markPbOk();
              return;
            }
            if (hasPluginBackendInAll(allPre)) {
              markPbOk();
              return;
            }
          } else {
            if (await findColl(data)) {
              markPbOk();
              return;
            }
            if (await hasPluginBackendOnWorkspace(data)) {
              markPbOk();
              return;
            }
          }
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000, data);
      if (lease.denied) return;
      try {
        let allLease;
        try {
          allLease = await getAllCollectionsDeduped(data);
        } catch (_) {
          allLease = null;
        }
        if (allLease != null) {
          if (pickCollFromAll(allLease)) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allLease)) {
            markPbOk();
            return;
          }
        } else {
          if (await findColl(data)) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs(data);
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            let allCont;
            try {
              allCont = await getAllCollectionsDeduped(data);
            } catch (_) {
              allCont = null;
            }
            if (allCont != null) {
              if (pickCollFromAll(allCont)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allCont)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs(data);
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            let allSettle;
            try {
              allSettle = await getAllCollectionsDeduped(data);
            } catch (_) {
              allSettle = null;
            }
            if (allSettle != null) {
              if (pickCollFromAll(allSettle)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allSettle)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
        }
        noteRecentPluginBackendCreateAttempt(data);
        const exactN = await countExactPluginBackendNamedCollections(data);
        if (exactN >= 1) {
          if (DEBUG_COLLECTIONS) {
            dlogPathB('abort_create_exact_backend_name_exists', { exactN, ws: workspaceSlugFromData(data) });
          }
          markPbOk();
          return;
        }
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate(data);
        markPbOk();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    if (isWorkspacePluginBackendEnsureDone(data)) {
      return Promise.resolve();
    }
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = findVaultRecord(records, pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  const LOCAL_MIRROR_META_PREFIX = 'thymerext_ps_local_meta_v1:';

  function localMirrorMetaKey(pluginId) {
    return LOCAL_MIRROR_META_PREFIX + encodeURIComponent(String(pluginId || 'unknown'));
  }

  function parseIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function readLocalMirrorMeta(pluginId) {
    try {
      const raw = localStorage.getItem(localMirrorMetaKey(pluginId));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
    return {};
  }

  function writeLocalMirrorMeta(pluginId, meta) {
    try {
      localStorage.setItem(localMirrorMetaKey(pluginId), JSON.stringify(meta || {}));
    } catch (_) {}
  }

  function markLocalMirrorKeys(pluginId, keys, updatedAt) {
    if (!pluginId || !Array.isArray(keys)) return;
    const meta = readLocalMirrorMeta(pluginId);
    const ts = updatedAt || new Date().toISOString();
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      let exists = false;
      try {
        exists = localStorage.getItem(k) !== null;
      } catch (_) {}
      if (!exists) continue;
      meta[k] = { updatedAt: ts };
      changed = true;
    }
    if (changed) writeLocalMirrorMeta(pluginId, meta);
  }

  function collectLocalMirrorPayload(keys) {
    const payload = {};
    if (!Array.isArray(keys)) return payload;
    for (const k of keys) {
      if (!k) continue;
      try {
        const v = localStorage.getItem(k);
        if (v !== null) payload[k] = v;
      } catch (_) {}
    }
    return payload;
  }

  function localPayloadMatchesRemote(keys, remote) {
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return false;
    if (!Array.isArray(keys)) return true;
    for (const k of keys) {
      if (!k) continue;
      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}
      const remoteValue = remote.payload[k];
      if (localValue === null && typeof remoteValue !== 'string') continue;
      if (localValue !== remoteValue) return false;
    }
    return true;
  }

  function applyRemoteMirrorPayload(pluginId, keys, remote) {
    const result = { needsFlush: false };
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return result;
    const meta = readLocalMirrorMeta(pluginId);
    const remoteUpdatedAt = String(remote.updatedAt || '');
    const remoteMs = parseIsoMs(remoteUpdatedAt);
    let metaChanged = false;
    for (const k of keys) {
      if (!k) continue;
      const remoteValue = remote.payload[k];
      if (typeof remoteValue !== 'string') continue;

      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}

      if (localValue === remoteValue) {
        if (remoteUpdatedAt && (!meta[k] || !meta[k].updatedAt)) {
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        }
        continue;
      }

      if (localValue === null) {
        try {
          localStorage.setItem(k, remoteValue);
          if (remoteUpdatedAt) {
            meta[k] = { updatedAt: remoteUpdatedAt };
            metaChanged = true;
          }
        } catch (_) {}
        continue;
      }

      const localMs = parseIsoMs(meta[k]?.updatedAt);
      if (localMs && remoteMs && remoteMs > localMs + 1000) {
        try {
          localStorage.setItem(k, remoteValue);
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        } catch (_) {}
        continue;
      }

      // When freshness is ambiguous, preserve the browser's current settings and let flushNow repair the vault row.
      result.needsFlush = true;
      if (!localMs) {
        meta[k] = { updatedAt: new Date().toISOString() };
        metaChanged = true;
      }
      console.warn('[ThymerPluginSettings] Kept local settings instead of overwriting with older/ambiguous synced payload', {
        pluginId,
        key: k,
        localUpdatedAt: meta[k]?.updatedAt || null,
        remoteUpdatedAt: remoteUpdatedAt || null,
      });
    }
    if (metaChanged) writeLocalMirrorMeta(pluginId, meta);
    return result;
  }

  function shouldFlushMirrorOnInit(keys, remote, applyResult) {
    if (applyResult?.needsFlush) return true;
    if (remote && remote.payload && typeof remote.payload === 'object') {
      return !localPayloadMatchesRemote(keys, remote);
    }
    return Object.keys(collectLocalMirrorPayload(keys)).length > 0;
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,
    preferDeferredHeavyWork,
    yieldToHostBeforePathB,
    ensureMobileLoadGraceStarted,
    inMobileLoadGrace,
    bumpMobileLoadGrace,
    installMobileResumeGraceListener,

    async init(opts) {
      ensureMobileLoadGraceStarted();
      installMobileResumeGraceListener();
      installMobileInteractionGraceListener();
      await yieldToHostBeforePathB();
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      let initFlushNeeded = false;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        const applyResult = applyRemoteMirrorPayload(pluginId, keys, remote);
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, applyResult);
      } else if (plugin._pluginSettingsSyncMode === 'synced') {
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, null);
      }

      if (plugin._pluginSettingsSyncMode === 'synced' && initFlushNeeded) {
        try {
          markLocalMirrorKeys(pluginId, keys);
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      markLocalMirrorKeys(plugin._pluginSettingsPluginId, keys);
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') {
        markLocalMirrorKeys(pluginId, keyList);
        await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      }
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };

  g.thymerExtEnsureMobileLoadGrace = ensureMobileLoadGraceStarted;
  g.thymerExtInMobileLoadGrace = inMobileLoadGrace;
  g.thymerExtShouldDeferPanelFooterWork = shouldDeferPanelFooterWork;
  g.thymerExtBumpMobileLoadGrace = bumpMobileLoadGrace;
  g.thymerExtPauseHeavyWorkQueue = pauseHeavyWorkQueue;
  g.thymerExtInstallMobileResumeGrace = installMobileResumeGraceListener;
  g.thymerExtInstallMobileInteractionGrace = installMobileInteractionGraceListener;
  g.thymerExtEnqueueHeavyWork = enqueueHeavyWork;
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings

/*
  FEATURES
  - Shows records from configured collections whose date field matches the journal date
  - Expandable inline preview with collapsible nested nodes
  - Click any preview line to navigate to that record
  - Settings panel: configure date field name(s) and included/excluded collections
  - Survives DOM rebuilds (recordExpandedState pattern from EXPANDABLE_PREVIEW_PATTERN.md)
  - Re-populates automatically when navigating between journal dates

  SETTINGS: localStorage "tn_settings_v1" (+ tn_footer_collapsed), or synced via Plugin Backend (path B — see PLUGIN_SETTINGS_PERSISTENCE.md)
  {
    dateFields: ["When", "when"],      // property names to check for date matching
    excludedCollections: ["Archives"], // collection names to hide
    panelLabel: "", // empty = default "Today's Notes"
    mainSortMode: "collection",       // "collection" | "chrono" — default for new journal days / footer expand
    chronoShowCollectionIcon: true,
    chronoShowCollectionName: true,
    timeMachine: {
      enabled: true,
      filters: [{ field: "When", op: "same_day_last_year", value: "" }],
      excludeJournalYearForMonthDay: true, // for "same month/day as journal", omit the journal year (avoids duplicating Today's Notes)
      groupWithinYear: "collection"       // "collection" | "chrono" — after year headings in Time Machine
    }
  }
*/

const TN_SETTINGS_KEY = 'tn_settings_v1';
const TN_TM_SECTION_KEY = '__timemachine__';
const TN_SETTINGS_PLUGIN_ID = 'todays-notes';
const TN_QUERY_CACHE_TTL_MS = 45000;

/** Staggered queue so multiple path-B plugins do not open first-run dialogs at once. */
(function pathBFirstRunQueue(g) {
  if (g.__thymerExtPathBApi) return;
  const q = [];
  let busy = false;
  const runNext = () => {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerExt PathB]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(runNext, 450);
      });
  };
  g.__thymerExtPathBApi = { enqueue(job) { q.push(job); runNext(); } };
})(typeof globalThis !== 'undefined' ? globalThis : window);

class Plugin extends AppPlugin {

  onLoad() {
    (async () => {
      await (globalThis.ThymerPluginSettings?.init?.({
        plugin: this,
        pluginId: TN_SETTINGS_PLUGIN_ID,
        modeKey: 'thymerext_ps_mode_todays-notes',
        mirrorKeys: () => [TN_SETTINGS_KEY, 'tn_footer_collapsed'],
        label: "Today's Notes",
        data: this.data,
        ui: this.ui,
      }) ?? (console.warn("[Today's Notes] ThymerPluginSettings runtime missing (redeploy full plugin .js from repo)."), Promise.resolve()));

      this._panelStates     = new Map();
      this._eventHandlerIds = [];
      this._recordsByDateCache = new Map();
      this._collapsed       = this._loadBool('tn_footer_collapsed', false);
      this._settings        = this._loadSettings();

      this._injectCSS();

      // Register settings panel
      this.ui.registerCustomPanelType('tn-settings', (panel) => this._mountSettingsPanel(panel));
      this.ui.addCommandPaletteCommand({
        label: "Today's Notes: Settings", icon: 'ti-settings',
        onSelected: () => this._openSettings(),
      });
      this.ui.addCommandPaletteCommand({
        label: "Today's Notes: Storage location…", icon: 'ti-database',
        onSelected: () => {
        globalThis.ThymerPluginSettings?.openStorageDialog?.({
          plugin: this,
          pluginId: TN_SETTINGS_PLUGIN_ID,
          modeKey: 'thymerext_ps_mode_todays-notes',
          mirrorKeys: () => [TN_SETTINGS_KEY, 'tn_footer_collapsed'],
          label: "Today's Notes",
          data: this.data,
          ui: this.ui,
        });
      },
      });

      this._eventHandlerIds.push(this.events.on('panel.navigated', ev => setTimeout(() => this._handlePanel(ev.panel), 400)));
      this._eventHandlerIds.push(this.events.on('panel.focused',   ev => this._handlePanel(ev.panel)));
      this._eventHandlerIds.push(this.events.on('panel.closed',    ev => this._disposePanel(ev.panel?.getId?.())));
      this._eventHandlerIds.push(this.events.on('record.created', () => this._onWorkspaceDataChanged()));
      this._eventHandlerIds.push(this.events.on('record.updated', (ev) => this._onRecordUpdatedForNotes(ev)));
      this._eventHandlerIds.push(this.events.on('record.moved',   () => this._onWorkspaceDataChanged()));
      // Thymer EventsAPI has no record.deleted; rely on record.updated / record.moved / panel events for refresh.

      setTimeout(() => {
        const p = this.ui.getActivePanel();
        if (p) this._handlePanel(p);
      }, 300);
    })().catch((e) => console.error("[Today's Notes] onLoad", e));
  }

  onUnload() {
    if (this._workspaceDataDebounceTimer) {
      try { clearTimeout(this._workspaceDataDebounceTimer); } catch (_) {}
      this._workspaceDataDebounceTimer = null;
    }
    for (const id of (this._eventHandlerIds || [])) {
      try { this.events.off(id); } catch (_) {}
    }
    this._eventHandlerIds = [];
    this._recordsByDateCache?.clear?.();
    for (const id of Array.from((this._panelStates || new Map()).keys())) this._disposePanel(id, { permanent: true });
    this._panelStates?.clear();
  }

  // =========================================================================
  // Settings
  // =========================================================================

  _defaultTimeMachine() {
    return {
      enabled: true,
      filters: [{ id: 'tm_default', field: 'When', op: 'same_day_last_year', value: '' }],
      excludeJournalYearForMonthDay: true,
      groupWithinYear: 'collection',
    };
  }

  _normalizeTimeMachine(tm) {
    const base = this._defaultTimeMachine();
    if (!tm || typeof tm !== 'object') return base;
    const enabled = tm.enabled !== false;
    const filters = Array.isArray(tm.filters) && tm.filters.length
      ? tm.filters.map((f, i) => ({
        id: String(f?.id || `tm_${i}`),
        field: String(f?.field || 'When').trim(),
        op: String(f?.op || 'same_day_last_year').trim(),
        value: f?.value != null ? String(f.value) : '',
      }))
      : base.filters;
    const excludeJournalYearForMonthDay = tm.excludeJournalYearForMonthDay !== false;
    const g = String(tm.groupWithinYear || '').trim().toLowerCase();
    const groupWithinYear = g === 'chrono' ? 'chrono' : 'collection';
    return { enabled, filters, excludeJournalYearForMonthDay, groupWithinYear };
  }

  _loadSettings() {
    try {
      const raw = localStorage.getItem(TN_SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const msm = String(parsed.mainSortMode || '').trim().toLowerCase();
        return {
          panelLabel:          typeof parsed.panelLabel === 'string' ? parsed.panelLabel : '',
          dateFields:          Array.isArray(parsed.dateFields)          ? parsed.dateFields          : ['When', 'when'],
          excludedCollections: Array.isArray(parsed.excludedCollections) ? parsed.excludedCollections : [],
          mainSortMode:        msm === 'chrono' ? 'chrono' : 'collection',
          chronoShowCollectionIcon: parsed.chronoShowCollectionIcon !== false,
          chronoShowCollectionName: parsed.chronoShowCollectionName !== false,
          timeMachine:         this._normalizeTimeMachine(parsed.timeMachine),
        };
      }
    } catch (_) {}
    return {
      panelLabel: '',
      dateFields: ['When', 'when'],
      excludedCollections: [],
      mainSortMode: 'collection',
      chronoShowCollectionIcon: true,
      chronoShowCollectionName: true,
      timeMachine: this._defaultTimeMachine(),
    };
  }

  _saveSettings() {
    try { localStorage.setItem(TN_SETTINGS_KEY, JSON.stringify(this._settings)); } catch (_) {}
    this._invalidateRecordsCache();
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => [TN_SETTINGS_KEY, 'tn_footer_collapsed']);
  }

  _settingsCacheSignature() {
    // Only include settings that change which records match. Display choices are
    // applied during render so toggling modes does not force another vault scan.
    const fields = Array.isArray(this._settings?.dateFields) ? this._settings.dateFields : [];
    const excluded = Array.isArray(this._settings?.excludedCollections) ? this._settings.excludedCollections : [];
    const f = fields.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).sort();
    const e = excluded.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean).sort();
    return JSON.stringify({ f, e });
  }

  _mainSortMode() {
    return this._settings?.mainSortMode === 'chrono' ? 'chrono' : 'collection';
  }

  _rememberMainSortMode(mode) {
    const next = mode === 'chrono' ? 'chrono' : mode === 'collection' ? 'collection' : '';
    if (!next || !this._settings || this._settings.mainSortMode === next) return;
    this._settings.mainSortMode = next;
    try { localStorage.setItem(TN_SETTINGS_KEY, JSON.stringify(this._settings)); } catch (_) {}
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => [TN_SETTINGS_KEY, 'tn_footer_collapsed']);
  }

  /** `activeMain`: 'collection' | 'chrono' | null. Initialize once from settings when still undefined. */
  _ensureDefaultActiveMain(state) {
    if (!state || state.activeMain !== undefined) return;
    try { delete state._sectionCollapsed?.['main:chrono']; } catch (_) {}
    state.activeMain = this._mainSortMode() === 'chrono' ? 'chrono' : 'collection';
  }

  /**
   * How the main list is shown for this panel (footer menu / clock toggles).
   * @returns {'chrono' | 'collection' | 'main_collapsed'}
   */
  _effectiveMainPresentation(state) {
    this._ensureDefaultActiveMain(state);
    if (state.activeMain === 'chrono') return 'chrono';
    if (state.activeMain === 'collection') return 'collection';
    return 'main_collapsed';
  }

  _triMainAndTmAllOff(state) {
    if (!state) return false;
    const mainOff = state.activeMain == null;
    const tmOff = !this._timeMachineEnabled() || !!state._sectionCollapsed?.[TN_TM_SECTION_KEY];
    return mainOff && tmOff;
  }

  /** When menu, clock, and Time Machine are all off, collapse the whole Today's Notes footer (non-suite). */
  _maybeCollapseEntireFooterIfTriAllOff(state) {
    if (!this._triMainAndTmAllOff(state)) return;
    if (this._tnJournalFooterSuiteEmbed) return;
    this._collapsed = true;
    this._saveBool('tn_footer_collapsed', this._collapsed);
    const root = state?.rootEl;
    if (root?.isConnected) {
      const body = root.querySelector('[data-role="body"]');
      if (body) body.style.display = 'none';
      this._applyFooterCollapsedVisual(root);
      const cal = root.querySelector('.tn-calendar-toggle');
      if (cal) {
        cal.title = "Show today's notes";
        cal.setAttribute('aria-expanded', 'false');
      }
    }
  }

  _resortMainResultsForPresentation(results, presentation) {
    const arr = Array.isArray(results) ? results.map((x) => ({ ...x })) : [];
    if (presentation === 'chrono') {
      arr.sort((a, b) => {
        const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
        const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
        if (ta !== tb) return ta - tb;
        return String(a.collectionName || '').localeCompare(String(b.collectionName || ''));
      });
    } else {
      arr.sort((a, b) => {
        const c = a.collectionName.localeCompare(b.collectionName);
        return c !== 0 ? c : a.dateVal - b.dateVal;
      });
    }
    return arr;
  }

  _chronoRowMeta() {
    return {
      showCollectionIcon: this._settings?.chronoShowCollectionIcon !== false,
      showCollectionName: this._settings?.chronoShowCollectionName !== false,
    };
  }

  _panelTitleText() {
    const p = String(this._settings?.panelLabel || '').trim();
    return p || "Today's Notes";
  }

  /** Standalone footer only: dim/bright shell from collapsed state. */
  _applyFooterCollapsedVisual(root) {
    if (!root?.classList?.contains?.('tn-footer') || root.classList.contains('tn-footer--suite-embed')) return;
    const collapsed = !!this._collapsed;
    root.classList.toggle('tn-footer--collapsed', collapsed);
  }

  _syncFooterTitles() {
    const t = this._panelTitleText();
    for (const [, s] of this._panelStates || new Map()) {
      const el = s.rootEl?.querySelector?.('.tn-title');
      if (el) el.textContent = t;
    }
  }

  _invalidateRecordsCache() {
    try { this._recordsByDateCache?.clear?.(); } catch (_) {}
  }

  /**
   * Path B plugins sync via a row in "Plugin Backend" (plugin_id + settings_json).
   * Those updates must not rebuild Today's Notes — e.g. Journal Image Gallery collapse
   * flushes twice (separate prop writes) and can fall outside our debounce window.
   */
  _onRecordUpdatedForNotes(ev) {
    if (this._isPluginSettingsRow(ev)) return;
    if (this._isJournalRecordUpdate(ev)) return;
    this._onWorkspaceDataChanged();
  }

  _isPluginSettingsRow(ev) {
    const guid = ev?.recordGuid;
    if (!guid) return false;
    let r;
    try { r = this.data.getRecord?.(guid); } catch (_) { r = null; }
    if (!r) return false;
    let pluginId = '';
    try {
      pluginId = String(r.text?.('plugin_id') ?? '').trim();
      if (!pluginId) {
        const p = r.prop?.('plugin_id');
        pluginId = String(p?.get?.() ?? p?.text?.() ?? '').trim();
      }
    } catch (_) {}
    if (!pluginId) return false;
    let payload = '';
    try {
      payload = String(r.text?.('settings_json') ?? '').trim();
      if (!payload) {
        const p = r.prop?.('settings_json');
        payload = String(p?.text?.() ?? p?.get?.() ?? '').trim();
      }
    } catch (_) {}
    return !!payload;
  }

  _isJournalRecordUpdate(ev) {
    const guid = ev?.recordGuid;
    if (!guid) return false;
    let r;
    try { r = this.data.getRecord?.(guid); } catch (_) { r = null; }
    if (!r) return false;
    return !!this._journalDayKeyFromRecord(r);
  }

  _onWorkspaceDataChanged() {
    // Coalesce bursts of record.* events (startup sync, Path B, other plugins) so we
    // do not clear/repaint the footer on every event — that caused visible flashing
    // and starved other footers mounting into the same container.
    if (this._workspaceDataDebounceTimer) {
      try { clearTimeout(this._workspaceDataDebounceTimer); } catch (_) {}
    }
    this._workspaceDataDebounceTimer = setTimeout(() => {
      this._workspaceDataDebounceTimer = null;
      this._invalidateRecordsCache();
      this._refreshAll();
    }, 320);
  }

  async _openSettings() {
    const panel = await this.ui.createPanel();
    if (!panel) return;
    const type = this._tnJournalFooterSuiteEmbed ? 'jfs-settings' : 'tn-settings';
    panel.navigateToCustomType(type);
  }

  /**
   * Build Today's Notes settings form into containerEl.
   * @param {HTMLElement} containerEl
   * @param {{ suiteEmbed?: boolean }} opts — suiteEmbed: omit inner save button (parent saves).
   * @returns {Promise<() => void>} applyDraft — persist `s` to plugin settings (no UI).
   */
  async _appendTodaysNotesSettingsInto(containerEl, opts = {}) {
    const suiteEmbed = !!opts.suiteEmbed;

    const allCollections = await this.data.getAllCollections();
    const journalNames   = new Set(['journal', 'journals']);
    const collections    = allCollections
      .map(c => c.getName() || '')
      .filter(n => n && !journalNames.has(n.toLowerCase()))
      .sort();

    const s = {
      panelLabel:          this._settings.panelLabel != null ? String(this._settings.panelLabel) : '',
      dateFields:          [...this._settings.dateFields],
      excludedCollections: new Set(this._settings.excludedCollections),
      mainSortMode:        this._settings.mainSortMode === 'chrono' ? 'chrono' : 'collection',
      chronoShowCollectionIcon: this._settings.chronoShowCollectionIcon !== false,
      chronoShowCollectionName: this._settings.chronoShowCollectionName !== false,
      timeMachine:         JSON.parse(JSON.stringify(this._normalizeTimeMachine(this._settings.timeMachine))),
    };

    const render = () => {
      containerEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = suiteEmbed
        ? 'display:flex;flex-direction:column;gap:16px;'
        : 'padding:24px;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:20px;';

      // ── Panel title ─────────────────────────────────────────────────────
      const titleSec = document.createElement('div');
      titleSec.appendChild(this._cfgLabel('Footer title',
        'Label shown in the journal footer (leave blank for the default).'));
      const plInp = document.createElement('input');
      plInp.type = 'text';
      plInp.placeholder = "Today's Notes";
      plInp.value = s.panelLabel;
      plInp.style.cssText = 'width:100%;padding:7px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;box-sizing:border-box;';
      plInp.addEventListener('input', () => { s.panelLabel = plInp.value; });
      titleSec.appendChild(plInp);
      wrap.appendChild(titleSec);

      // ── Date fields ────────────────────────────────────────────────────
      const dfSec = document.createElement('div');
      dfSec.appendChild(this._cfgLabel('Date Field Names',
        'Property names to check for the date. Add all variants used across your collections.'));

      s.dateFields.forEach((field, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;';
        const inp = document.createElement('input');
        inp.type  = 'text'; inp.value = field;
        inp.style.cssText = 'flex:1;padding:7px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);outline:none;';
        inp.addEventListener('input', () => { s.dateFields[i] = inp.value.trim(); });
        const rm = document.createElement('button');
        rm.textContent = '✕';
        rm.style.cssText = 'background:none;border:none;color:var(--text-muted,#888);cursor:pointer;font-size:13px;padding:4px 6px;flex-shrink:0;';
        rm.addEventListener('click', () => { s.dateFields.splice(i, 1); render(); });
        row.appendChild(inp); row.appendChild(rm);
        dfSec.appendChild(row);
      });

      const addFieldBtn = document.createElement('button');
      addFieldBtn.textContent = '+ Add field name';
      addFieldBtn.style.cssText = 'padding:6px 12px;background:transparent;border:1px dashed var(--border-default,#3f3f46);border-radius:6px;font-size:12px;color:var(--text-muted,#888);cursor:pointer;margin-top:4px;';
      addFieldBtn.addEventListener('click', () => { s.dateFields.push(''); render(); });
      dfSec.appendChild(addFieldBtn);
      wrap.appendChild(dfSec);

      // ── Collections ────────────────────────────────────────────────────
      const collSec = document.createElement('div');
      collSec.appendChild(this._cfgLabel('Collections',
        'Uncheck any collections you don\'t want to appear in Today\'s Notes.'));

      collections.forEach(name => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);';
        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = !s.excludedCollections.has(name);
        cb.style.cssText = 'width:15px;height:15px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);flex-shrink:0;';
        cb.addEventListener('change', () => {
          if (cb.checked) s.excludedCollections.delete(name);
          else s.excludedCollections.add(name);
        });
        const lbl = document.createElement('span');
        lbl.textContent = name;
        lbl.style.cssText = 'font-size:13px;';
        row.appendChild(cb); row.appendChild(lbl);
        collSec.appendChild(row);
      });
      wrap.appendChild(collSec);

      // ── Display / grouping ──────────────────────────────────────────────
      const dispSec = document.createElement('div');
      dispSec.appendChild(this._cfgLabel('Display',
        'How to order notes that match the journal day. Collection grouping is unchanged from before when you pick "By collection".'));

      const sortLab = document.createElement('label');
      sortLab.style.cssText = 'display:block;font-size:12px;color:var(--text-muted,#8a7e6a);margin-bottom:6px;';
      sortLab.textContent = 'Order notes';
      dispSec.appendChild(sortLab);

      const sortSel = document.createElement('select');
      sortSel.style.cssText = 'width:100%;padding:7px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);margin-bottom:10px;';
      [['collection', 'By collection (default)'], ['chrono', 'By time (chronological within the day)']].forEach(([val, lab]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = lab;
        sortSel.appendChild(o);
      });
      sortSel.value = s.mainSortMode === 'chrono' ? 'chrono' : 'collection';
      sortSel.addEventListener('change', () => { s.mainSortMode = sortSel.value === 'chrono' ? 'chrono' : 'collection'; render(); });
      dispSec.appendChild(sortSel);

      const chronoOpts = document.createElement('div');
      chronoOpts.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px 0 4px;border-top:1px solid rgba(255,255,255,0.06);';
      const showWhenChrono = s.mainSortMode === 'chrono';
      chronoOpts.style.display = showWhenChrono ? 'flex' : 'none';

      const mkChronoCb = (label, key) => {
        const lb = document.createElement('label');
        lb.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = s[key] !== false;
        cb.style.cssText = 'width:15px;height:15px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);';
        cb.addEventListener('change', () => { s[key] = cb.checked; });
        const sp = document.createElement('span');
        sp.textContent = label;
        lb.appendChild(cb);
        lb.appendChild(sp);
        return lb;
      };
      chronoOpts.appendChild(this._cfgLabel('When sorted by time',
        'Show where each note lives without switching back to collection groups.'));
      chronoOpts.appendChild(mkChronoCb('Show collection icon', 'chronoShowCollectionIcon'));
      chronoOpts.appendChild(mkChronoCb('Show collection name', 'chronoShowCollectionName'));
      dispSec.appendChild(chronoOpts);

      wrap.appendChild(dispSec);

      // ── Time Machine ───────────────────────────────────────────────────
      const tmSec = document.createElement('div');
      tmSec.appendChild(this._cfgLabel('Time Machine',
        'Optional section at the bottom of the footer. Filters use the journal page date as context.'));

      const tmEn = document.createElement('label');
      tmEn.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-bottom:10px;';
      const tmCb = document.createElement('input');
      tmCb.type = 'checkbox';
      tmCb.checked = s.timeMachine.enabled !== false;
      tmCb.addEventListener('change', () => { s.timeMachine.enabled = tmCb.checked; });
      const tmLb = document.createElement('span');
      tmLb.textContent = 'Show Time Machine section';
      tmEn.appendChild(tmCb);
      tmEn.appendChild(tmLb);
      tmSec.appendChild(tmEn);

      s.timeMachine.filters = Array.isArray(s.timeMachine.filters) ? s.timeMachine.filters : [];
      const tmFiltersWrap = document.createElement('div');
      tmFiltersWrap.style.cssText =
        'display:flex;flex-direction:column;gap:8px;margin-top:12px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;';

      const opChoices = [
        ['same_day_last_year', 'Same calendar day, last year'],
        ['on_journal_day', 'On journal day'],
        ['same_month_day_as_journal', 'Same month/day as journal (any year)'],
        ['not_on_journal_day', 'Not on journal day'],
        ['eq', 'Text equals'],
        ['neq', 'Text not equals'],
        ['contains', 'Text contains'],
        ['not_contains', 'Text does not contain'],
        ['starts_with', 'Text starts with'],
        ['ends_with', 'Text ends with'],
        ['is_empty', 'Field empty'],
        ['is_not_empty', 'Field not empty'],
      ];

      const renderTmFilters = () => {
        tmFiltersWrap.innerHTML = '';
        s.timeMachine.filters.forEach((rule, ridx) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;';
          const fin = document.createElement('input');
          fin.type = 'text';
          fin.placeholder = 'Field name (e.g. When)';
          fin.value = rule.field || '';
          fin.style.cssText = 'flex:1;min-width:100px;padding:6px 8px;border-radius:6px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
          fin.addEventListener('input', () => { s.timeMachine.filters[ridx].field = fin.value.trim(); });
          const opSel = document.createElement('select');
          opSel.style.cssText = 'padding:6px 8px;border-radius:6px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
          for (const [val, lab] of opChoices) {
            const o = document.createElement('option');
            o.value = val;
            o.textContent = lab;
            opSel.appendChild(o);
          }
          opSel.value = opChoices.some(([v]) => v === rule.op) ? rule.op : 'same_day_last_year';
          opSel.addEventListener('change', () => { s.timeMachine.filters[ridx].op = opSel.value; });
          const vin = document.createElement('input');
          vin.type = 'text';
          vin.placeholder = 'Compare value (text ops)';
          vin.value = rule.value || '';
          vin.style.cssText = 'flex:1;min-width:80px;padding:6px 8px;border-radius:6px;font-size:12px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
          vin.addEventListener('input', () => { s.timeMachine.filters[ridx].value = vin.value; });
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.textContent = '✕';
          rm.style.cssText = 'background:none;border:none;color:var(--text-muted,#888);cursor:pointer;font-size:12px;padding:4px;';
          rm.addEventListener('click', () => { s.timeMachine.filters.splice(ridx, 1); renderTmFilters(); });
          row.appendChild(fin);
          row.appendChild(opSel);
          row.appendChild(vin);
          row.appendChild(rm);
          tmFiltersWrap.appendChild(row);
        });
      };
      renderTmFilters();
      const addTmFilter = document.createElement('button');
      addTmFilter.type = 'button';
      addTmFilter.textContent = '+ Add filter rule';
      addTmFilter.style.cssText = 'margin-top:6px;padding:6px 12px;background:transparent;border:1px dashed var(--border-default,#3f3f46);border-radius:6px;font-size:12px;color:var(--text-muted,#888);cursor:pointer;';
      addTmFilter.addEventListener('click', () => {
        s.timeMachine.filters.push({ id: `tm_${Date.now()}`, field: 'When', op: 'same_day_last_year', value: '' });
        renderTmFilters();
      });
      tmSec.appendChild(tmFiltersWrap);
      tmSec.appendChild(addTmFilter);

      const tmExtra = document.createElement('div');
      tmExtra.style.cssText =
        'display:flex;flex-direction:column;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.06);';
      tmExtra.appendChild(this._cfgLabel('Same month/day as journal',
        'Skip the journal year for that filter so notes already listed in Today\'s Notes do not repeat here (on by default).'));

      const exclLb = document.createElement('label');
      exclLb.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;';
      const exclCb = document.createElement('input');
      exclCb.type = 'checkbox';
      exclCb.checked = s.timeMachine.excludeJournalYearForMonthDay !== false;
      exclCb.style.cssText = 'width:15px;height:15px;cursor:pointer;accent-color:var(--color-primary-500,#a78bfa);';
      exclCb.addEventListener('change', () => { s.timeMachine.excludeJournalYearForMonthDay = exclCb.checked; });
      const exclSp = document.createElement('span');
      exclSp.textContent = 'Exclude journal calendar year from "same month/day" results';
      exclLb.appendChild(exclCb);
      exclLb.appendChild(exclSp);
      tmExtra.appendChild(exclLb);

      tmExtra.appendChild(this._cfgLabel('Inside Time Machine',
        'Results are grouped by year. Choose how to order notes within each year (same choices as above).'));
      const tmGroupSel = document.createElement('select');
      tmGroupSel.style.cssText = 'width:100%;padding:7px 10px;border-radius:6px;font-size:13px;background:var(--bg-default,#18181b);color:inherit;border:1px solid var(--border-default,#3f3f46);';
      [['collection', 'By collection'], ['chrono', 'By time']].forEach(([val, lab]) => {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = lab;
        tmGroupSel.appendChild(o);
      });
      tmGroupSel.value = s.timeMachine.groupWithinYear === 'chrono' ? 'chrono' : 'collection';
      tmGroupSel.addEventListener('change', () => { s.timeMachine.groupWithinYear = tmGroupSel.value === 'chrono' ? 'chrono' : 'collection'; });
      tmExtra.appendChild(tmGroupSel);

      tmSec.appendChild(tmExtra);
      wrap.appendChild(tmSec);

      if (!suiteEmbed) {
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save Settings';
        saveBtn.style.cssText = 'padding:10px 0;background:var(--color-primary-500,#a78bfa);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer;width:100%;';
        saveBtn.addEventListener('click', () => {
          applyDraft();
          this.ui.addToaster({ title: 'Saved', message: "Today's Notes settings saved.", dismissible: true, autoDestroyTime: 3000 });
        });
        wrap.appendChild(saveBtn);
      }
      containerEl.appendChild(wrap);
    };

    const applyDraft = () => {
      this._settings = {
        panelLabel:          String(s.panelLabel || '').trim(),
        dateFields:          s.dateFields.filter(f => f.trim()),
        excludedCollections: Array.from(s.excludedCollections),
        mainSortMode:        s.mainSortMode === 'chrono' ? 'chrono' : 'collection',
        chronoShowCollectionIcon: s.chronoShowCollectionIcon !== false,
        chronoShowCollectionName: s.chronoShowCollectionName !== false,
        timeMachine:         this._normalizeTimeMachine(s.timeMachine),
      };
      this._saveSettings();
      this._syncFooterTitles();
      this._refreshAll();
    };

    render();
    return applyDraft;
  }

  async _mountSettingsPanel(panel) {
    const el = panel.getElement();
    if (!el) return;
    panel.setTitle("Today's Notes — Settings");
    el.innerHTML = '';
    el.style.cssText = 'padding:0;overflow:auto;height:100%;box-sizing:border-box;';
    await this._appendTodaysNotesSettingsInto(el, { suiteEmbed: false });
  }

  // =========================================================================
  // Panel lifecycle
  // =========================================================================

  _handlePanel(panel) {
    const panelId = panel?.getId?.();
    if (!panelId) return;

    const navType = panel?.getNavigation?.()?.type || '';
    if (navType === 'custom' || navType === 'custom_panel') { this._disposePanel(panelId); return; }

    const panelEl   = panel?.getElement?.();
    const container = this._findContainer(panelEl);

    // If container not found, set up a watcher to retry once it appears
    if (!container) {
      if (!this._isMutationObserveTarget(panelEl)) return;
      let state = this._panelStates.get(panelId);
      if (!state) {
        state = {
          panelId, panel, journalDate: 'unknown',
          rootEl: null, observer: null,
          loading: false, loaded: false,
          recordExpandedState: new Map(),
          _containerWatcher: null,
          _sectionCollapsed: {},
          _lastMainResults: [],
          _lastCollectionIcons: {},
          timeMachineResults: null,
          timeMachineLoading: false,
        };
        this._panelStates.set(panelId, state);

        // Watch panelEl for container to appear
        state._containerWatcher = new MutationObserver(() => {
          const newContainer = this._findContainer(panelEl);
          if (newContainer) {
            try { state._containerWatcher?.disconnect(); } catch (_) {}
            state._containerWatcher = null;
            this._handlePanel(panel); // Retry now that container exists
          }
        });
        try {
          state._containerWatcher.observe(panelEl, { childList: true, subtree: true });
        } catch (_) {
          try { state._containerWatcher.disconnect(); } catch (_) {}
          state._containerWatcher = null;
        }
      }
      return;
    }

    const record = panel?.getActiveRecord?.();
    if (!record)  { this._disposePanel(panelId); return; }

    const journalDate = this._journalDayKeyFromRecord(record);
    if (!journalDate) { this._disposePanel(panelId); return; }

    let state = this._panelStates.get(panelId);
    const dateChanged = state?.journalDate !== journalDate;

    if (!state) {
      state = {
        panelId, panel, journalDate,
        rootEl: null, observer: null,
        loading: false, loaded: false,
        recordExpandedState: new Map(),
        _sectionCollapsed: {},
        _lastMainResults: [],
        _lastCollectionIcons: {},
        timeMachineResults: null,
        timeMachineLoading: false,
      };
      this._panelStates.set(panelId, state);
      const pKey = `${panelId}\t${String(journalDate || '')}`;
      const prev = this._tnPreservedSectionCollapse?.get?.(pKey);
      if (prev && typeof prev === 'object' && Object.keys(prev).length) {
        state._sectionCollapsed = { ...prev };
        this._tnPreservedSectionCollapse.delete(pKey);
      }
    } else {
      // Disconnect container watcher if it exists (we found the container now)
      try { state._containerWatcher?.disconnect(); } catch (_) {}
      state._containerWatcher = null;

      const priorJournalDate = state.journalDate;
      state.journalDate = journalDate;
      state.panel       = panel;
      state._sectionCollapsed = state._sectionCollapsed || {};
      if (state.timeMachineResults === undefined) state.timeMachineResults = null;
      if (state.timeMachineLoading === undefined) state.timeMachineLoading = false;
      // Reset state when date changes
      if (dateChanged) {
        if (this._tnJournalFooterSuiteEmbed && this._tnPreservedSectionCollapse) {
          const oldKey = `${panelId}\t${String(priorJournalDate || '')}`;
          this._tnPreservedSectionCollapse.delete(oldKey);
        }
        state.loaded = false;
        state.recordExpandedState = new Map();
        state._sectionCollapsed = {};
        state.timeMachineResults = null;
        state.timeMachineLoading = false;
        state.activeMain = this._mainSortMode() === 'chrono' ? 'chrono' : 'collection';
        state._sectionCollapsed[TN_TM_SECTION_KEY] = true;
      }
    }

    const rebuilt = this._mountFooter(state, container, panelEl);
    if (rebuilt) state.loading = false; // Cancel any in-progress populate targeting the old rootEl
    if (dateChanged || !state.loaded || rebuilt) {
      if (state.loading) {
        state._pendingPopulate = true; // In-progress fetch is stale; retry after it finishes
      } else {
        this._populate(state);
      }
    }
  }

  _disposePanel(panelId, opts = {}) {
    if (!panelId) return;
    const s = this._panelStates.get(panelId);
    if (!s) return;

    if (opts.permanent && this._tnPreservedSectionCollapse) {
      const prefix = `${panelId}\t`;
      for (const k of Array.from(this._tnPreservedSectionCollapse.keys())) {
        if (k.startsWith(prefix)) this._tnPreservedSectionCollapse.delete(k);
      }
    } else if (this._tnJournalFooterSuiteEmbed && s) {
      try {
        if (!this._tnPreservedSectionCollapse) this._tnPreservedSectionCollapse = new Map();
        const key = `${panelId}\t${String(s.journalDate || '')}`;
        this._tnPreservedSectionCollapse.set(key, JSON.parse(JSON.stringify(s._sectionCollapsed || {})));
      } catch (_) {}
    }

    try { s.observer?.disconnect(); } catch (_) {}
    try { s._containerWatcher?.disconnect(); } catch (_) {}
    if (this._tnJournalFooterSuiteEmbed && s.rootEl) {
      const host = this._resolveJfsTnExtrasHost(s, s.rootEl);
      if (host) {
        host.innerHTML = '';
        host.style.display = 'none';
        try {
          host.style.removeProperty('flex');
        } catch (_) {}
      }
    }
    try { s.rootEl?.remove(); }       catch (_) {}
    this._panelStates.delete(panelId);
  }

  _refreshAll() {
    for (const [, s] of (this._panelStates || new Map())) {
      s.loaded = false;
      this._populate(s);
    }
  }

  // =========================================================================
  // DOM mounting
  // =========================================================================

  // Returns true if the footer was (re)built, false if it was already in place
  _mountFooter(state, container, panelEl) {
    // If footer exists, is connected, and is in the right container — no rebuild needed
    if (state.rootEl && state.rootEl.isConnected && state.rootEl.parentElement === container) {
      // Ensure observer is live (re-create if it was somehow lost)
      if (!state.observer) {
        state.observer = this._createFooterObserver(state, panelEl);
      }
      return false; // Already mounted — no rebuild
    }

    // Footer needs to be (re)built
    if (state.observer) {
      try { state.observer.disconnect(); } catch (_) {}
      state.observer = null;
    }
    clearTimeout(state._navTimer);

    // Remove any stale orphan footers for this panel
    const stale = container.querySelectorAll(`:scope > .tn-footer[data-panel-id="${state.panelId}"]`);
    for (const el of stale) { try { el.remove(); } catch (_) {} }

    state.rootEl = this._buildRoot(state);
    container.appendChild(state.rootEl);

    state.observer = this._createFooterObserver(state, panelEl);
    return true; // Footer was rebuilt — caller should re-populate
  }

  _createFooterObserver(state, panelEl) {
    if (!this._isMutationObserveTarget(panelEl)) return null;
    const obs = new MutationObserver(() => {
      if (state.rootEl && !state.rootEl.isConnected) {
        clearTimeout(state._navTimer);
        state._navTimer = setTimeout(() => {
          if (state.panel && state.rootEl && !state.rootEl.isConnected) {
            this._handlePanel(state.panel);
          }
        }, 300);
      }
    });
    try {
      obs.observe(panelEl, { childList: true, subtree: true });
    } catch (_) {
      try { obs.disconnect(); } catch (_) {}
      return null;
    }
    return obs;
  }

  _isMutationObserveTarget(el) {
    return !!(el && typeof el === 'object' && typeof Node !== 'undefined' && el instanceof Node);
  }

  _findContainer(panelEl) {
    if (!panelEl) return null;
    for (const sel of ['.page-content', '.editor-wrapper', '.editor-panel', '#editor']) {
      if (panelEl.matches?.(sel)) return panelEl;
      const all = panelEl.querySelectorAll?.(sel);
      if (all && all.length) return all[all.length - 1];
    }
    return null;
  }

  _timeMachineEnabled() {
    const tm = this._normalizeTimeMachine(this._settings?.timeMachine);
    return !!tm.enabled && Array.isArray(tm.filters) && tm.filters.length > 0;
  }

  _collectionSectionKey(name) {
    return `coll:${String(name || '').trim().toLowerCase()}`;
  }

  _allInnerTnSectionsCollapsed(state) {
    if (!state) return false;
    const main = state._lastMainResults || [];
    const pres = this._effectiveMainPresentation(state);
    if (pres === 'main_collapsed' && main.length > 0) {
      /* main list intentionally hidden */
    } else if (pres === 'chrono' && main.length > 0) {
      return false;
    } else {
      const byColl = this._groupResultsByCollection(main);
      for (const name of byColl.keys()) {
        const sk = this._collectionSectionKey(name);
        if (!(sk in state._sectionCollapsed)) state._sectionCollapsed[sk] = false;
        if (!state._sectionCollapsed[sk]) return false;
      }
    }
    if (this._timeMachineEnabled()) {
      if (!(TN_TM_SECTION_KEY in state._sectionCollapsed)) state._sectionCollapsed[TN_TM_SECTION_KEY] = true;
      if (!state._sectionCollapsed[TN_TM_SECTION_KEY]) return false;
    }
    const byCollEnd = this._groupResultsByCollection(main);
    const hasMain =
      (pres === 'main_collapsed' && main.length > 0) ||
      (pres === 'chrono' && main.length > 0) ||
      byCollEnd.size > 0;
    return hasMain || this._timeMachineEnabled();
  }

  _expandAllTnSections(state) {
    if (!state) return;
    const main = state._lastMainResults || [];
    state.activeMain = this._mainSortMode() === 'chrono' ? 'chrono' : 'collection';
    const byColl = this._groupResultsByCollection(main);
    for (const name of byColl.keys()) {
      state._sectionCollapsed[this._collectionSectionKey(name)] = false;
    }
    if (this._timeMachineEnabled()) state._sectionCollapsed[TN_TM_SECTION_KEY] = false;
  }

  /** Ensure `.jfs-tn-extras` has collapsed chips + tri icon row (suite embed only). */
  _ensureJfsTnExtrasShell(state, host) {
    if (!host) return;
    if (!host.querySelector('.tn-collapsed-sections-wrap')) {
      const wrap = document.createElement('span');
      wrap.className = 'tn-collapsed-sections-wrap';
      host.appendChild(wrap);
    }
    if (!host.querySelector('.tn-header-tri')) {
      const tri = this._createTriHeaderRow(state);
      host.appendChild(tri);
    }
  }

  _createTriHeaderRow(state) {
    const wrap = document.createElement('span');
    wrap.className = 'tn-header-tri';

    const mk = (cls, icon, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${cls} button-none button-small button-minimal-hover`;
      b.title = title;
      b.setAttribute('aria-label', title);
      try {
        b.appendChild(this.ui.createIcon(icon));
      } catch (_) {
        b.textContent = '?';
      }
      return b;
    };

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'tn-tri-menu button-none button-small button-minimal-hover';
    menuBtn.title = 'By collection';
    menuBtn.setAttribute('aria-label', 'By collection');
    this._appendByCollectionModeIcon(menuBtn);
    menuBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.activeMain === 'collection') state.activeMain = null;
      else {
        state.activeMain = 'collection';
        this._rememberMainSortMode('collection');
      }
      this._maybeCollapseEntireFooterIfTriAllOff(state);
      this._renderFooterBody(state);
      this._syncTnHeaderExtras(state);
    });

    const clockBtn = mk('tn-tri-clock', 'ti-clock', 'By time');
    clockBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.activeMain === 'chrono') state.activeMain = null;
      else {
        state.activeMain = 'chrono';
        this._rememberMainSortMode('chrono');
      }
      this._maybeCollapseEntireFooterIfTriAllOff(state);
      this._renderFooterBody(state);
      this._syncTnHeaderExtras(state);
    });

    const tmBtn = document.createElement('button');
    tmBtn.type = 'button';
    tmBtn.className = 'tn-tri-tm button-none button-small button-minimal-hover';
    tmBtn.title = 'Time Machine';
    tmBtn.setAttribute('aria-label', 'Time Machine');
    this._appendTmGenerateIcon(tmBtn, 18);
    tmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this._timeMachineEnabled()) return;
      const cur = !!state._sectionCollapsed?.[TN_TM_SECTION_KEY];
      state._sectionCollapsed[TN_TM_SECTION_KEY] = !cur;
      if (!state._sectionCollapsed[TN_TM_SECTION_KEY]) {
        void this._runTimeMachineGenerate(state);
      } else {
        this._maybeCollapseEntireFooterIfTriAllOff(state);
      }
      this._renderFooterBody(state);
      this._syncTnHeaderExtras(state);
    });

    const triDivider = document.createElement('span');
    triDivider.className = 'tn-header-tri-divider';
    triDivider.setAttribute('aria-hidden', 'true');

    wrap.appendChild(menuBtn);
    wrap.appendChild(clockBtn);
    wrap.appendChild(triDivider);
    wrap.appendChild(tmBtn);
    return wrap;
  }

  _syncTriHeaderRow(state, tnRoot, footCollapsed) {
    const row =
      tnRoot?.querySelector?.('.tn-header-tri') ||
      tnRoot?.closest?.('.jfs-shell')?.querySelector?.('.jfs-tn-extras .tn-header-tri');
    if (!row) return;
    if (footCollapsed) {
      row.style.display = 'none';
      return;
    }
    row.style.display = 'inline-flex';
    this._ensureDefaultActiveMain(state);

    const menuBtn = row.querySelector('.tn-tri-menu');
    const clockBtn = row.querySelector('.tn-tri-clock');
    const tmBtn = row.querySelector('.tn-tri-tm');
    if (menuBtn) {
      const on = state.activeMain === 'collection';
      menuBtn.classList.toggle('tn-tri-lit', on);
      menuBtn.classList.toggle('tn-tri-dim', !on);
      menuBtn.title = on ? 'By collection (click to hide)' : 'By collection (click to show)';
    }
    if (clockBtn) {
      const on = state.activeMain === 'chrono';
      clockBtn.classList.toggle('tn-tri-lit', on);
      clockBtn.classList.toggle('tn-tri-dim', !on);
      clockBtn.title = on ? 'By time (click to hide)' : 'By time (click to show)';
    }
    if (tmBtn) {
      if (!this._timeMachineEnabled()) {
        tmBtn.disabled = true;
        tmBtn.style.opacity = '0.35';
        tmBtn.style.pointerEvents = 'none';
        tmBtn.classList.remove('tn-tri-lit', 'tn-tri-dim');
        tmBtn.title = 'Time Machine disabled in settings';
      } else {
        tmBtn.disabled = false;
        tmBtn.style.opacity = '';
        tmBtn.style.pointerEvents = '';
        const tmCollapsed = !!state._sectionCollapsed?.[TN_TM_SECTION_KEY];
        const on = !tmCollapsed;
        tmBtn.classList.toggle('tn-tri-lit', on);
        tmBtn.classList.toggle('tn-tri-dim', !on);
        tmBtn.title = on ? 'Time Machine (click to hide)' : 'Time Machine (click to show)';
      }
    }
  }

  /** Resolve Journal Footer Suite `.jfs-tn-extras` (fallback when tn-footer is not under `.jfs-shell`). */
  _resolveJfsTnExtrasHost(state, tnRoot) {
    const fromTn = tnRoot?.closest?.('.jfs-shell')?.querySelector?.('.jfs-tn-extras');
    if (fromTn) return fromTn;
    const panelEl = state?.panel?.getElement?.();
    if (!panelEl) return null;
    let shell = null;
    try {
      const id = String(state.panelId || '');
      if (id && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        shell = panelEl.querySelector(`.jfs-shell[data-panel-id="${CSS.escape(id)}"]`);
      }
    } catch (_) {}
    if (!shell) shell = panelEl.querySelector('.jfs-shell');
    return shell?.querySelector('.jfs-tn-extras') || null;
  }

  _syncTnHeaderExtras(state) {
    const tnRoot = state?.rootEl;
    if (!tnRoot) return;
    const footCollapsed = this._tnJournalFooterSuiteEmbed ? false : this._collapsed;

    let wrap;
    /** @type {HTMLElement | null} */
    let jfsHost = null;

    const suiteDom = !!tnRoot.classList?.contains?.('tn-footer--suite-embed');
    if (this._tnJournalFooterSuiteEmbed || suiteDom) {
      jfsHost = this._resolveJfsTnExtrasHost(state, tnRoot);
      if (!jfsHost) return;
      this._ensureJfsTnExtrasShell(state, jfsHost);
      wrap = jfsHost.querySelector('.tn-collapsed-sections-wrap');
    } else {
      wrap = tnRoot.querySelector('.tn-collapsed-sections-wrap');
    }

    if (!wrap) return;

    this._syncTriHeaderRow(state, tnRoot, footCollapsed);

    wrap.innerHTML = '';
    if (footCollapsed) return;

    const mainRes = state._lastMainResults || [];
    const byColl = this._groupResultsByCollection(mainRes);
    for (const collName of byColl.keys()) {
      const sk = this._collectionSectionKey(collName);
      if (!state._sectionCollapsed?.[sk]) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tn-collapsed-chip button-none button-small button-minimal-hover';
      btn.title = `Expand ${collName}`;
      btn.dataset.tnExpandSection = sk;
      const iconWrap = document.createElement('span');
      iconWrap.className = 'tn-collapsed-chip-icon';
      const rawIcon = (state._lastCollectionIcons && state._lastCollectionIcons[collName]) || '';
      if (!this._appendCollectionIconVisual(iconWrap, rawIcon)) {
        this._appendByCollectionModeIcon(iconWrap);
      }
      btn.appendChild(iconWrap);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        state._sectionCollapsed[sk] = false;
        state.activeMain = 'collection';
        if (this._collapsed && !this._tnJournalFooterSuiteEmbed) {
          this._collapsed = false;
          this._saveBool('tn_footer_collapsed', this._collapsed);
          const body = tnRoot.querySelector('[data-role="body"]');
          const cal = tnRoot.querySelector('.tn-calendar-toggle');
          if (body) body.style.display = 'block';
          this._applyFooterCollapsedVisual(tnRoot);
          if (cal) {
            cal.title = "Hide today's notes";
            cal.setAttribute('aria-expanded', 'true');
          }
        }
        this._renderFooterBody(state);
        this._syncTnHeaderExtras(state);
      });
      wrap.appendChild(btn);
    }

    if (jfsHost) {
      jfsHost.style.setProperty('display', 'flex', 'important');
      jfsHost.style.flex = '0 0 auto';
      jfsHost.style.alignItems = 'center';
      jfsHost.style.justifyContent = 'flex-end';
    }
  }

  _groupResultsByCollection(results) {
    const m = new Map();
    for (const item of results || []) {
      const n = item.collectionName || '';
      if (!m.has(n)) m.set(n, []);
      m.get(n).push(item);
    }
    return m;
  }

  _tmItemYear(item) {
    const d =
      item.dateVal instanceof Date && !Number.isNaN(item.dateVal.getTime())
        ? item.dateVal
        : this._coerceDateForTm(item.dateVal);
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.getFullYear();
  }

  /** Split Time Machine hits into calendar years (descending order list) plus unknown-date bucket. */
  _groupTmResultsByYearDescending(items) {
    const yearMap = new Map();
    const unknown = [];
    for (const it of items || []) {
      const y = this._tmItemYear(it);
      if (y == null || Number.isNaN(y)) {
        unknown.push(it);
        continue;
      }
      if (!yearMap.has(y)) yearMap.set(y, []);
      yearMap.get(y).push(it);
    }
    const years = Array.from(yearMap.keys()).sort((a, b) => b - a);
    return { yearMap, years, unknown };
  }

  _sortTmItemsByTimeAscending(items) {
    return [...(items || [])].sort((a, b) => {
      const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
      const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
      return ta - tb;
    });
  }

  _createIconNode(iconNames) {
    const list = Array.isArray(iconNames) ? iconNames : [iconNames];
    for (const name of list) {
      const key = String(name || '').trim();
      if (!key) continue;
      try {
        const node = this.ui.createIcon?.(key);
        if (node) return node;
      } catch (_) {}
    }
    return null;
  }

  _appendCollectionIconVisual(parent, rawIcon) {
    if (!parent) return false;
    const s = String(rawIcon || '').trim();
    if (!s) return false;
    if (/[^\x00-\x7F]/.test(s) && !/^ti[-\s]/i.test(s)) {
      const span = document.createElement('span');
      span.className = 'tn-collection-icon-emoji';
      span.textContent = s;
      span.setAttribute('aria-hidden', 'true');
      parent.appendChild(span);
      return true;
    }
    const candidates = [];
    if (s.startsWith('ti-')) {
      candidates.push(s, s.slice(3));
    } else {
      candidates.push(`ti-${s.replace(/^ti-?/i, '')}`, s);
    }
    for (const c of candidates) {
      const node = this._createIconNode([c]);
      if (node) {
        parent.appendChild(node);
        return true;
      }
    }
    const slug = (s.startsWith('ti-') ? s.slice(3) : s.replace(/^ti-?/i, '')).replace(/_/g, '-').replace(/\s+/g, '-');
    if (/^[a-z0-9-]+$/i.test(slug)) {
      const i = document.createElement('i');
      i.className = `ti ti-${slug.toLowerCase()}`;
      i.setAttribute('aria-hidden', 'true');
      parent.appendChild(i);
      return true;
    }
    return false;
  }

  _collectionIconName(coll) {
    if (!coll) return '';
    const candidates = [];
    const push = (v) => {
      if (v == null || typeof v === 'object') return;
      const t = String(v).trim();
      if (t) candidates.push(t);
    };
    try {
      const cfg = coll.getConfiguration?.() || {};
      push(cfg.icon);
      push(cfg.collection_icon);
      push(cfg.iconName);
      push(cfg.emoji);
    } catch (_) {}
    try {
      const data = coll?.getData?.() || {};
      push(data.icon);
      push(data.emoji);
    } catch (_) {}
    push(coll?.icon);
    try { push(coll.getIcon?.()); } catch (_) {}
    for (const raw of candidates) {
      if (/^ti-photo$/i.test(raw)) continue;
      if (raw.startsWith('ti-')) return raw;
      if (/^[a-z0-9_-]+$/i.test(raw)) return `ti-${raw.replace(/^ti-?/, '').replace(/_/g, '-')}`;
      if (/[^\x00-\x7F]/.test(raw)) return raw;
    }
    return '';
  }

  /**
   * "By collection" header glyph. `ti-menu-alt` is often missing from Thymer's bundled Tabler set;
   * try known slugs then raw `ti ti-*` so the webfont still renders when `createIcon` returns null.
   */
  _appendByCollectionModeIcon(parent) {
    if (!parent) return;
    const candidates = ['ti-layout-list', 'ti-menu-2', 'ti-list', 'ti-align-justified', 'ti-folder'];
    const node = this._createIconNode(candidates);
    if (node) {
      parent.appendChild(node);
      return;
    }
    const slugs = ['layout-list', 'menu-2', 'list', 'folder'];
    for (const slug of slugs) {
      const i = document.createElement('i');
      i.className = `ti ti-${slug}`;
      i.setAttribute('aria-hidden', 'true');
      parent.appendChild(i);
      return;
    }
    const span = document.createElement('span');
    span.textContent = '☰';
    span.setAttribute('aria-hidden', 'true');
    parent.appendChild(span);
  }

  /** Time Machine header control — hourglass in both collapsed and expanded states (matches section icon). */
  _appendTmGenerateIcon(btn, size = 18) {
    if (!btn) return;
    btn.innerHTML = '';
    try {
      const node = this.ui.createIcon('ti-hourglass');
      if (node) {
        btn.appendChild(node);
        return;
      }
    } catch (_) {}
    btn.textContent = '⏳';
  }

  _journalDateParts(yyyymmdd) {
    const y = parseInt(String(yyyymmdd || '').slice(0, 4), 10);
    const m = parseInt(String(yyyymmdd || '').slice(4, 6), 10);
    const d = parseInt(String(yyyymmdd || '').slice(6, 8), 10);
    return { year: y, month: m, day: d, yyyymmdd: String(yyyymmdd || '') };
  }

  _dayRangeFromKey(yyyymmdd) {
    const p = this._journalDateParts(yyyymmdd);
    const start = new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
    const end = new Date(p.year, p.month - 1, p.day, 23, 59, 59, 999);
    return { start, end };
  }

  _dayRangeSameDayLastYear(yyyymmdd) {
    const p = this._journalDateParts(yyyymmdd);
    const start = new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
    start.setFullYear(start.getFullYear() - 1);
    const end = new Date(p.year, p.month - 1, p.day, 23, 59, 59, 999);
    end.setFullYear(end.getFullYear() - 1);
    return { start, end };
  }

  _coerceDateForTm(raw) {
    if (!raw) return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
    if (typeof raw?.toDate === 'function') {
      const d = raw.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw?.value === 'function') {
      const d = new Date(raw.value());
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'number') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'string' && raw.length >= 8) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  }

  _readDateFieldNamed(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key) return null;
    try {
      const prop = record.prop(key);
      if (!prop) return null;
      if (typeof prop.date === 'function') {
        const d = prop.date();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
      }
      return this._coerceDateForTm(prop.get?.());
    } catch (_) {}
    return null;
  }

  _readFieldValueSimple(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key) return '';
    try {
      const prop = record.prop(key);
      if (!prop) return '';
      const raw = prop.get?.();
      if (raw == null) return '';
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      if (raw instanceof Date) return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
      if (typeof raw?.label === 'string') return raw.label;
      if (typeof raw?.name === 'string') return raw.name;
      return String(raw);
    } catch (_) {
      return '';
    }
  }

  _recordPassesTmFilters(record, journalYyyymmdd) {
    const tm = this._normalizeTimeMachine(this._settings?.timeMachine);
    const filters = tm.filters || [];
    const journalParts = this._journalDateParts(journalYyyymmdd);
    const dayRange = this._dayRangeFromKey(journalYyyymmdd);
    const lastYearRange = this._dayRangeSameDayLastYear(journalYyyymmdd);
    for (const rule of filters) {
      if (!this._evaluateTmFilterRule(record, rule, journalParts, dayRange, lastYearRange)) return false;
    }
    return true;
  }

  _evaluateTmFilterRule(record, rule, journalParts, dayRange, lastYearRange) {
    const field = String(rule?.field || '').trim();
    const op = String(rule?.op || '').trim();
    const cmpRaw = String(rule?.value || '');
    if (!field && op !== 'always') return true;

    const isDateOp = ['on_journal_day', 'not_on_journal_day', 'same_month_day_as_journal', 'same_day_last_year'].includes(op);
    const raw = isDateOp ? this._readDateFieldNamed(record, field) : this._readFieldValueSimple(record, field);
    const value = (v) => {
      if (v == null) return '';
      if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
      return String(v).toLowerCase();
    };
    const cmp = String(cmpRaw || '').toLowerCase();

    if (op === 'is_empty') {
      if (isDateOp) return !this._coerceDateForTm(raw);
      const vs = this._readFieldValueSimple(record, field);
      return !vs || !String(vs).trim();
    }
    if (op === 'is_not_empty') {
      if (isDateOp) return !!this._coerceDateForTm(raw);
      const vs = this._readFieldValueSimple(record, field);
      return !!vs && !!String(vs).trim();
    }

    if (op === 'same_month_day_as_journal') {
      const d = this._coerceDateForTm(raw);
      if (!d) return false;
      if (d.getMonth() + 1 !== journalParts.month || d.getDate() !== journalParts.day) return false;
      const tmCfg = this._normalizeTimeMachine(this._settings?.timeMachine);
      if (tmCfg.excludeJournalYearForMonthDay !== false && d.getFullYear() === journalParts.year) return false;
      return true;
    }
    if (op === 'on_journal_day') {
      const d = this._coerceDateForTm(raw);
      if (!d) return false;
      return d >= dayRange.start && d <= dayRange.end;
    }
    if (op === 'not_on_journal_day') {
      const d = this._coerceDateForTm(raw);
      if (!d) return true;
      return !(d >= dayRange.start && d <= dayRange.end);
    }
    if (op === 'same_day_last_year') {
      const d = this._coerceDateForTm(raw);
      if (!d) return false;
      return d >= lastYearRange.start && d <= lastYearRange.end;
    }

    const v = value(raw);
    if (op === 'eq') return v === cmp;
    if (op === 'neq') return v !== cmp;
    if (op === 'contains') return v.includes(cmp);
    if (op === 'not_contains') return !v.includes(cmp);
    if (op === 'starts_with') return v.startsWith(cmp);
    if (op === 'ends_with') return v.endsWith(cmp);
    return true;
  }

  async _queryTimeMachineRecords(journalYyyymmdd) {
    const excludedSet = new Set((this._settings.excludedCollections || []).map((n) => n.toLowerCase()));
    const journalNames = new Set(['journal', 'journals']);
    const collections = await this.data.getAllCollections();
    const out = [];
    for (const coll of collections) {
      const name = coll.getName() || '';
      if (!name || journalNames.has(name.toLowerCase())) continue;
      if (excludedSet.has(name.toLowerCase())) continue;
      let records;
      try { records = await coll.getAllRecords(); } catch (_) { continue; }
      const icon = this._collectionIconName(coll);
      const tm0 = this._normalizeTimeMachine(this._settings.timeMachine).filters[0];
      for (const record of records) {
        if (!this._recordPassesTmFilters(record, journalYyyymmdd)) continue;
        let dateVal = this._getDateFieldValue(record);
        if (tm0?.field) {
          const named = this._readDateFieldNamed(record, tm0.field);
          if (named) dateVal = named;
        }
        const d = this._coerceDateForTm(dateVal);
        out.push({ record, collectionName: name, dateVal: d || dateVal || null, collectionIcon: icon });
      }
    }
    out.sort((a, b) => {
      const c = a.collectionName.localeCompare(b.collectionName);
      if (c !== 0) return c;
      const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
      const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
      return ta - tb;
    });
    return out;
  }

  /** When Time Machine is expanded but has never been queried (null), kick off a load (e.g. main footer expand-all). */
  _maybeKickTimeMachineLoad(state) {
    if (!this._timeMachineEnabled() || !state?.journalDate) return;
    if (state._sectionCollapsed?.[TN_TM_SECTION_KEY]) return;
    if (state.timeMachineLoading) return;
    if (state.timeMachineResults != null) return;
    void this._runTimeMachineGenerate(state);
  }

  async _runTimeMachineGenerate(state) {
    if (!this._timeMachineEnabled() || !state?.journalDate) return;
    state.timeMachineLoading = true;
    this._renderFooterBody(state);
    this._syncTnHeaderExtras(state);
    try {
      state.timeMachineResults = await this._queryTimeMachineRecords(state.journalDate);
    } catch (e) {
      console.error('[TodaysNotes] Time Machine', e);
      state.timeMachineResults = [];
    }
    state.timeMachineLoading = false;
    this._renderFooterBody(state);
    this._syncTnHeaderExtras(state);
  }

  _renderFooterBody(state) {
    const targetRootEl = state?.rootEl;
    if (!targetRootEl?.isConnected) return;
    const bodyEl = targetRootEl.querySelector('[data-role="body"]');
    if (!bodyEl) return;
    const raw = state._lastMainResults || [];
    const pres = this._effectiveMainPresentation(state);
    const results =
      !raw.length || pres === 'main_collapsed'
        ? raw
        : this._resortMainResultsForPresentation(raw.map((x) => ({ ...x })), pres);
    bodyEl.innerHTML = '';

    if (this._collapsed && !this._tnJournalFooterSuiteEmbed) {
      this._syncTnHeaderExtras(state);
      return;
    }

    if (!raw.length) {
      if (!this._timeMachineEnabled()) {
        bodyEl.innerHTML = '<div class="tn-empty">No notes found for this day.</div>';
      }
    } else {
      if (pres === 'main_collapsed') {
        /* notes hidden via footer cycle */
      } else if (pres === 'chrono') {
        const list = document.createElement('div');
        list.className = 'tn-chrono-body';
        const rowMeta = this._chronoRowMeta();
        for (const item of results) list.appendChild(this._buildRow(item, state, rowMeta));
        bodyEl.appendChild(list);
      } else {
        const byColl = this._groupResultsByCollection(results);
        for (const [collName, items] of byColl) {
          const sk = this._collectionSectionKey(collName);
          if (!(sk in state._sectionCollapsed)) state._sectionCollapsed[sk] = false;
          if (state._sectionCollapsed[sk]) continue;
          const icon = (state._lastCollectionIcons && state._lastCollectionIcons[collName]) || '';
          bodyEl.appendChild(this._buildCollectionSectionEl(collName, items, icon, sk, state));
        }
      }
    }

    if (this._timeMachineEnabled()) {
      if (!(TN_TM_SECTION_KEY in state._sectionCollapsed)) state._sectionCollapsed[TN_TM_SECTION_KEY] = true;
      if (!state._sectionCollapsed[TN_TM_SECTION_KEY]) {
        bodyEl.appendChild(this._buildTimeMachineSectionEl(state));
      }
    }

    const hasCollapsed = Object.keys(state._sectionCollapsed || {}).some((k) => state._sectionCollapsed[k]);
    const hasMainNotes = raw.length > 0;
    if (!hasMainNotes && bodyEl.children.length === 0 && !hasCollapsed && !this._timeMachineEnabled()) {
      bodyEl.innerHTML = '<div class="tn-empty">No notes found for this day.</div>';
    } else if (!hasMainNotes && bodyEl.children.length === 0 && hasCollapsed && !this._timeMachineEnabled()) {
      bodyEl.innerHTML = '';
    }
    this._syncTnHeaderExtras(state);
  }

  _buildCollectionSectionEl(collName, items, rawIcon, sectionKey, state) {
    const wrap = document.createElement('div');
    wrap.className = 'tn-section';

    const head = document.createElement('div');
    head.className = 'tn-section-head';

    const hoverWrap = document.createElement('div');
    hoverWrap.className = 'tn-section-head-inner';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'tn-section-icon';
    if (!this._appendCollectionIconVisual(iconWrap, rawIcon)) {
      this._appendByCollectionModeIcon(iconWrap);
    }

    const title = document.createElement('div');
    title.className = 'tn-section-title';
    title.textContent = collName;

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'tn-section-collapse-btn button-none';
    collapseBtn.innerHTML = '<i class="ti ti-chevron-up" aria-hidden="true"></i>';
    collapseBtn.title = 'Collapse section';
    const collapse = (ev) => {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      state._sectionCollapsed[sectionKey] = true;
      this._renderFooterBody(state);
      this._syncTnHeaderExtras(state);
    };
    collapseBtn.addEventListener('click', collapse);
    hoverWrap.addEventListener('click', (ev) => {
      if (ev.target.closest?.('.tn-section-collapse-btn')) return;
      collapse(ev);
    });

    hoverWrap.append(iconWrap, title, collapseBtn);
    head.appendChild(hoverWrap);
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'tn-section-body';
    for (const item of items) list.appendChild(this._buildRow(item, state));
    wrap.appendChild(list);
    return wrap;
  }

  _buildTimeMachineSectionEl(state) {
    const wrap = document.createElement('div');
    wrap.className = 'tn-section tn-tm-section';

    const head = document.createElement('div');
    head.className = 'tn-section-head tn-tm-head';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tn-section-icon';
    try {
      iconWrap.appendChild(this.ui.createIcon('ti-hourglass'));
    } catch (_) {
      iconWrap.textContent = '⏳';
    }
    const title = document.createElement('div');
    title.className = 'tn-section-title';
    title.textContent = 'Time Machine';

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'tn-section-collapse-btn button-none';
    collapseBtn.innerHTML = '<i class="ti ti-chevron-up" aria-hidden="true"></i>';
    collapseBtn.title = 'Collapse Time Machine';
    collapseBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      state._sectionCollapsed[TN_TM_SECTION_KEY] = true;
      this._renderFooterBody(state);
      this._syncTnHeaderExtras(state);
    });
    const headInner = document.createElement('div');
    headInner.className = 'tn-section-head-inner';
    headInner.append(iconWrap, title, collapseBtn);
    head.appendChild(headInner);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'tn-section-body tn-tm-body';
    wrap.appendChild(body);

    if (state.timeMachineLoading) {
      const loading = document.createElement('div');
      loading.className = 'tn-loading';
      loading.textContent = 'Loading Time Machine…';
      body.appendChild(loading);
      return wrap;
    }

    if (state.timeMachineResults == null) {
      return wrap;
    }

    if (!state.timeMachineResults.length) {
      const empty = document.createElement('div');
      empty.className = 'tn-empty';
      empty.textContent = 'No records matched your Time Machine filters.';
      body.appendChild(empty);
      return wrap;
    }

    const tmCfg = this._normalizeTimeMachine(this._settings?.timeMachine);
    const rowMeta = this._chronoRowMeta();
    const { yearMap, years, unknown } = this._groupTmResultsByYearDescending(state.timeMachineResults);

    const renderYearBucket = (yearLabel, items) => {
      const yearHead = document.createElement('div');
      yearHead.className = 'tn-tm-year-head';
      yearHead.textContent = yearLabel;
      body.appendChild(yearHead);

      if (tmCfg.groupWithinYear === 'chrono') {
        for (const item of this._sortTmItemsByTimeAscending(items)) {
          body.appendChild(this._buildRow(item, state, rowMeta));
        }
        return;
      }
      const byColl = this._groupResultsByCollection(items);
      const collNames = Array.from(byColl.keys()).sort((a, b) => String(a).localeCompare(String(b)));
      for (const collName of collNames) {
        const subLabel = document.createElement('div');
        subLabel.className = 'tn-tm-subcoll';
        subLabel.textContent = collName;
        body.appendChild(subLabel);
        for (const item of this._sortTmItemsByTimeAscending(byColl.get(collName) || [])) {
          body.appendChild(this._buildRow(item, state, null));
        }
      }
    };

    for (const y of years) renderYearBucket(String(y), yearMap.get(y) || []);
    if (unknown.length) renderYearBucket('Other', unknown);

    return wrap;
  }

  _buildRoot(state) {
    const root = document.createElement('div');
    root.className       = this._tnJournalFooterSuiteEmbed ? 'tn-footer tn-footer--suite-embed' : 'tn-footer';
    root.dataset.panelId = state.panelId;

    if (this._tnJournalFooterSuiteEmbed) {
      // Collapsed chips + TM shortcut live in `.jfs-tn-extras` (same row as tabs); see `_syncTnHeaderExtras`.
      const body = document.createElement('div');
      body.dataset.role  = 'body';
      body.className     = 'tn-body';
      body.style.display = 'block';
      root.addEventListener('click', (e) => this._handleClick(e, state));
      root.appendChild(body);
      return root;
    }

    const header = document.createElement('div');
    header.className = 'tn-header';

    const calToggle = document.createElement('button');
    calToggle.type = 'button';
    calToggle.className = 'tn-calendar-toggle button-none button-small button-minimal-hover';
    calToggle.title = this._collapsed ? "Show today's notes" : "Hide today's notes";
    calToggle.setAttribute('aria-expanded', String(!this._collapsed));
    try {
      calToggle.appendChild(this.ui.createIcon('ti-calendar'));
    } catch (_) {
      calToggle.textContent = '📅';
    }

    const collapsedSectionsWrap = document.createElement('span');
    collapsedSectionsWrap.className = 'tn-collapsed-sections-wrap';

    const triHeaderRow = this._createTriHeaderRow(state);

    const settingsBtn = document.createElement('button');
    settingsBtn.type      = 'button';
    settingsBtn.className = 'tn-settings-btn button-none button-small button-minimal-hover';
    settingsBtn.title     = 'Settings';
    settingsBtn.textContent = '⚙';
    settingsBtn.addEventListener('click', () => this._openSettings());

    header.appendChild(calToggle);
    header.appendChild(collapsedSectionsWrap);
    header.appendChild(triHeaderRow);
    header.appendChild(settingsBtn);

    const body = document.createElement('div');
    body.dataset.role  = 'body';
    body.className     = 'tn-body';
    body.style.display = this._collapsed ? 'none' : 'block';

    calToggle.addEventListener('click', () => {
      const wasCollapsed = this._collapsed;
      this._collapsed    = !this._collapsed;
      if (!this._collapsed && wasCollapsed) {
        if (state.activeMain == null) {
          state.activeMain = this._mainSortMode() === 'chrono' ? 'chrono' : 'collection';
        }
        if (this._allInnerTnSectionsCollapsed(state)) {
          this._expandAllTnSections(state);
        }
      }
      this._saveBool('tn_footer_collapsed', this._collapsed);
      body.style.display = this._collapsed ? 'none' : 'block';
      calToggle.title = this._collapsed ? "Show today's notes" : "Hide today's notes";
      calToggle.setAttribute('aria-expanded', String(!this._collapsed));
      this._applyFooterCollapsedVisual(root);
      if (!this._collapsed) {
        this._renderFooterBody(state);
        this._maybeKickTimeMachineLoad(state);
      }
      this._syncTnHeaderExtras(state);
    });

    root.addEventListener('click', (e) => this._handleClick(e, state));

    root.appendChild(header);
    root.appendChild(body);
    this._applyFooterCollapsedVisual(root);
    return root;
  }

  // =========================================================================
  // Click delegation
  // =========================================================================

  _handleClick(e, state) {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'expand-record') {
      e.stopPropagation();
      const recordGuid = actionEl.dataset.recordGuid || '';
      const groupEl    = actionEl.closest('.tn-record-group');
      if (groupEl) this._toggleRecordExpansion(state, recordGuid, groupEl).catch(() => {});
    }

    if (action === 'toggle-preview-node') {
      e.stopPropagation();
      const nodeGuid   = actionEl.dataset.nodeGuid   || '';
      const recordGuid = actionEl.dataset.recordGuid || '';
      const cached     = state?.recordExpandedState?.get?.(recordGuid);
      if (cached?.collapsedNodes) {
        const previewEl = actionEl.closest('.tlr-record-preview');
        if (cached.collapsedNodes.has(nodeGuid)) cached.collapsedNodes.delete(nodeGuid);
        else cached.collapsedNodes.add(nodeGuid);
        if (previewEl && cached.allItems) {
          this._renderRecordPreview(previewEl, cached.allItems, recordGuid, cached.collapsedNodes, state);
        }
      }
    }

    if (action === 'open-line') {
      e.stopPropagation();
      const recordGuid = actionEl.dataset.recordGuid || '';
      if (recordGuid) {
        state.panel?.navigateTo({
          workspaceGuid: this.getWorkspaceGuid(),
          type: 'edit_panel', rootId: recordGuid, subId: recordGuid,
        });
      }
    }
  }

  // =========================================================================
  // Data & rendering
  // =========================================================================

  async _populate(state) {
    if (state.loading) { return; }
    state.loading = true;

    // Capture current rootEl and date — used after the async call to detect if we've been superseded
    const targetRootEl = state.rootEl;
    const targetDate   = state.journalDate;

    const bodyEl = targetRootEl?.querySelector('[data-role="body"]');
    if (!bodyEl) { state.loading = false; return; }

    this._syncFooterTitles();

    bodyEl.innerHTML = '<div class="tn-loading">Scanning vault…</div>';

    try {
      const onScanProgress = (msg) => {
        if (state.rootEl !== targetRootEl || state.journalDate !== targetDate) return;
        const el = targetRootEl?.querySelector('.tn-loading');
        if (el) el.textContent = msg;
      };
      let results = await this._getRecordsForDate(targetDate, onScanProgress);

      // If rootEl was rebuilt or date changed while we awaited, our results are stale — abort
      if (state.rootEl !== targetRootEl || state.journalDate !== targetDate) {
        state.loading = false;
        if (state._pendingPopulate) { state._pendingPopulate = false; this._populate(state); }
        return;
      }
      if (!state.rootEl.isConnected) { state.loading = false; return; }

      if (!this._timeMachineEnabled()) {
        state.timeMachineResults = null;
        state.timeMachineLoading = false;
      }

      results = this._resortMainResultsForPresentation(results, this._effectiveMainPresentation(state));
      state._lastMainResults = results;
      state._lastCollectionIcons = {};
      for (const item of results) {
        const n = item.collectionName;
        if (n && item.collectionIcon && !state._lastCollectionIcons[n]) {
          state._lastCollectionIcons[n] = item.collectionIcon;
        }
      }

      this._renderFooterBody(state);

      state.loaded = true;
    } catch (e) {
      console.error('[TodaysNotes]', e);
      if (state.rootEl === targetRootEl && targetRootEl.isConnected) {
        bodyEl.innerHTML = '<div class="tn-empty">Error loading records.</div>';
      }
    }

    state.loading = false;
    if (state._pendingPopulate) { state._pendingPopulate = false; this._populate(state); }
  }

  _buildRow(item, state, rowMeta = null) {
    const guid = item.record.guid;

    const groupEl = document.createElement('div');
    groupEl.className          = 'tn-record-group';
    groupEl.dataset.recordGuid = guid;

    // Restore expanded class after DOM rebuild (EXPANDABLE_PREVIEW_PATTERN.md §3)
    if (state?.recordExpandedState?.get?.(guid)?.expanded === true) {
      groupEl.classList.add('tlr-record-expanded');
    }

    const row = document.createElement('div');
    row.className = 'tn-row';

    const meta = rowMeta || { showCollectionIcon: false, showCollectionName: false };

    const nameBtn = document.createElement('button');
    nameBtn.type        = 'button';
    nameBtn.className   = 'tn-record-name button-none';
    nameBtn.textContent = item.record.getName() || 'Untitled';
    nameBtn.addEventListener('click', () => {
      state.panel?.navigateTo({
        workspaceGuid: this.getWorkspaceGuid(),
        type: 'edit_panel', rootId: guid, subId: guid,
      });
    });

    const arrow = document.createElement('button');
    arrow.type      = 'button';
    arrow.className = 'tn-arrow button-none';
    arrow.title     = 'Open';
    try { arrow.appendChild(this.ui.createIcon('ti-arrow-right')); }
    catch (_) { arrow.textContent = '→'; }
    arrow.addEventListener('click', () => {
      state.panel?.navigateTo({
        workspaceGuid: this.getWorkspaceGuid(),
        type: 'edit_panel', rootId: guid, subId: guid,
      });
    });

    row.appendChild(this._buildExpandRecordBtn(guid, state));
    if (meta.showCollectionIcon || meta.showCollectionName) {
      const strip = document.createElement('span');
      strip.className = 'tn-row-coll-strip';
      if (meta.showCollectionIcon) {
        const iw = document.createElement('span');
        iw.className = 'tn-row-coll-ico';
        const ric = item.collectionIcon || '';
        if (!this._appendCollectionIconVisual(iw, ric)) {
          this._appendByCollectionModeIcon(iw);
        }
        strip.appendChild(iw);
      }
      if (meta.showCollectionName && String(item.collectionName || '').trim()) {
        const nm = document.createElement('span');
        nm.className = 'tn-row-coll-name';
        nm.textContent = item.collectionName;
        strip.appendChild(nm);
      }
      row.appendChild(strip);
    }
    row.appendChild(nameBtn);
    row.appendChild(arrow);
    groupEl.appendChild(row);
    groupEl.appendChild(this._buildRecordPreviewEl(guid, state));

    return groupEl;
  }

  // =========================================================================
  // Expandable preview (EXPANDABLE_PREVIEW_PATTERN.md)
  // =========================================================================

  _buildExpandRecordBtn(recordGuid, state) {
    const isExpanded  = state?.recordExpandedState?.get?.(recordGuid)?.expanded === true;
    const btn         = document.createElement('button');
    btn.type          = 'button';
    btn.className     = 'tlr-expand-record-btn button-none' + (isExpanded ? ' is-expanded' : '');
    btn.dataset.action     = 'expand-record';
    btn.dataset.recordGuid = recordGuid;
    btn.title       = isExpanded ? 'Hide record preview' : 'Preview record content inline';
    btn.textContent = isExpanded ? '▼' : '▶';
    return btn;
  }

  _buildRecordPreviewEl(recordGuid, state) {
    const previewEl           = document.createElement('div');
    previewEl.className       = 'tlr-record-preview';
    previewEl.dataset.previewGuid = recordGuid;
    const cached = state?.recordExpandedState?.get?.(recordGuid);
    if (cached?.expanded && cached?.allItems) {
      this._renderRecordPreview(previewEl, cached.allItems, recordGuid, cached.collapsedNodes || new Set(), state);
    }
    return previewEl;
  }

  async _toggleRecordExpansion(state, recordGuid, groupEl) {
    if (!state || !recordGuid || !groupEl) return;

    const expandBtn = groupEl.querySelector(`.tlr-expand-record-btn[data-record-guid="${recordGuid}"]`);
    const previewEl = groupEl.querySelector('.tlr-record-preview');
    const cached    = state.recordExpandedState.get(recordGuid);

    if (cached?.expanded) {
      state.recordExpandedState.set(recordGuid, { expanded: false, allItems: null, collapsedNodes: new Set() });
      groupEl.classList.remove('tlr-record-expanded');
      if (expandBtn) { expandBtn.classList.remove('is-expanded'); expandBtn.title = 'Preview record content inline'; expandBtn.textContent = '▶'; }
      if (previewEl) previewEl.innerHTML = '';
      return;
    }

    groupEl.classList.add('tlr-record-expanded');
    if (previewEl) { previewEl.innerHTML = ''; const l = document.createElement('div'); l.className = 'tlr-expand-loading'; l.textContent = 'Loading…'; previewEl.appendChild(l); }

    try {
      const record       = this.data.getRecord?.(recordGuid) || null;
      if (!record) throw new Error('Record not found');
      const rawItems     = await record.getLineItems();

      // Log transclusion items for debugging
      const transclusionItems = rawItems.filter(item => item?.type === 'ref' || item?.type === 'transclusion');
      if (transclusionItems.length > 0) {
        console.log('[TN-TRANSCLUSION-DEBUG]', { recordGuid, count: transclusionItems.length, items: transclusionItems });
      }

      const allItems     = await this._resolveTransclusions(rawItems, recordGuid);
      const collapsedNodes = new Set();
      state.recordExpandedState.set(recordGuid, { expanded: true, allItems, collapsedNodes });
      if (previewEl) this._renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes, state);
    } catch (_) {
      if (previewEl) { previewEl.innerHTML = ''; const e = document.createElement('div'); e.className = 'tlr-expand-empty'; e.textContent = 'Could not load record content.'; previewEl.appendChild(e); }
      state.recordExpandedState.set(recordGuid, { expanded: true, allItems: [], collapsedNodes: new Set() });
    }

    if (expandBtn) { expandBtn.classList.add('is-expanded'); expandBtn.title = 'Hide record preview'; expandBtn.textContent = '▼'; }
  }

  async _resolveTransclusions(items, recordGuid) {
    const visited = new Set([recordGuid]);
    const result  = [];

    for (const item of items) {
      const isTransclusion = item?.type === 'ref' || item?.type === 'transclusion';
      if (!isTransclusion) { result.push(item); continue; }

      // Extract GUID using the same sources as _appendLineText
      // Try segments first (most reliable), then fallbacks
      const refGuid = item?.segments?.[0]?.text?.guid ||
                      item?.segments?.[0]?.guid ||
                      item?.ref_guid ||
                      item?.guid_ref ||
                      item?.props?.guid ||
                      item?.props?.record_guid ||
                      null;

      if (!refGuid || visited.has(refGuid)) {
        result.push(item);
        continue;
      }
      visited.add(refGuid);

      try {
        const refRecord = this.data.getRecord?.(refGuid);
        const refItems  = refRecord ? await refRecord.getLineItems() : null;
        if (refItems && refItems.length > 0) {
          const transParent = item.parent_guid || recordGuid;
          const mapped = refItems.map(ri => {
            const isRoot = !ri.parent_guid || ri.parent_guid === refGuid;
            return isRoot ? Object.assign({}, ri, { parent_guid: transParent }) : ri;
          });
          result.push(...mapped);
          continue;
        }
      } catch (_) {}

      result.push(item); // fallback
    }
    return result;
  }

  _renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes, state) {
    if (!previewEl) return;
    previewEl.innerHTML = '';

    if (!allItems || allItems.length === 0) {
      const e = document.createElement('div'); e.className = 'tlr-expand-empty'; e.textContent = '(empty)'; previewEl.appendChild(e); return;
    }

    const childrenOf = new Map();
    for (const item of allItems) {
      const p = item.parent_guid || recordGuid;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(item);
    }

    const renderNode = (item, depth) => {
      const guid        = item.guid || '';
      const children    = childrenOf.get(guid) || [];
      const hasChildren = children.length > 0;
      const isCollapsed = collapsedNodes.has(guid);

      const nodeEl = document.createElement('div');
      nodeEl.className = 'tlr-preview-node';
      nodeEl.style.setProperty('--tlr-depth', depth);

      const rowEl = document.createElement('div');
      rowEl.className = 'tlr-preview-row';

      if (hasChildren) {
        const toggleEl = document.createElement('button');
        toggleEl.type      = 'button';
        toggleEl.className = 'tlr-preview-toggle button-none';
        toggleEl.dataset.action     = 'toggle-preview-node';
        toggleEl.dataset.nodeGuid   = guid;
        toggleEl.dataset.recordGuid = recordGuid;
        toggleEl.setAttribute('aria-label', isCollapsed ? 'Expand' : 'Collapse');
        toggleEl.textContent = isCollapsed ? '▶' : '▼';
        rowEl.appendChild(toggleEl);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'tlr-preview-spacer';
        rowEl.appendChild(spacer);
      }

      // Line content — clickable to navigate to record
      const lineBtn = document.createElement('button');
      lineBtn.type      = 'button';
      lineBtn.className = 'tlr-expand-line button-none';
      lineBtn.dataset.action     = 'open-line';
      lineBtn.dataset.recordGuid = recordGuid;
      lineBtn.dataset.lineGuid   = guid;
      this._appendLineText(lineBtn, item);
      rowEl.appendChild(lineBtn);

      nodeEl.appendChild(rowEl);

      if (hasChildren) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'tlr-preview-children' + (isCollapsed ? ' is-hidden' : '');
        for (const child of children) childrenEl.appendChild(renderNode(child, depth + 1));
        nodeEl.appendChild(childrenEl);
      }

      return nodeEl;
    };

    for (const root of (childrenOf.get(recordGuid) || [])) previewEl.appendChild(renderNode(root, 0));
  }

  _appendLineText(container, line) {
    // Handle transcluded lines — type 'ref' with no segments
    if (line?.type === 'ref' || line?.type === 'transclusion') {
      const refGuid = line?.ref_guid || line?.guid_ref || (line?.segments?.[0]?.text?.guid);
      const name    = refGuid ? (this._resolveRecordName(refGuid) || '[transcluded block]') : '[transcluded block]';
      const el      = document.createElement('span');
      el.className  = 'tn-seg-ref';
      el.textContent = '↪ ' + name;
      container.appendChild(el);
      return;
    }

    const prefix = this._linePrefix(line);
    if (prefix) {
      const p = document.createElement('span'); p.className = 'tn-prefix'; p.textContent = prefix; container.appendChild(p);
    }

    // If segments are empty but it's a ref-type block, show placeholder
    const segs = line?.segments || [];
    if (segs.length === 0) {
      // Could be an empty line or unsupported type — render nothing visible
      return;
    }

    const content = document.createElement('span');
    content.className = 'tn-line-content';
    this._appendSegments(content, segs);
    container.appendChild(content);
  }

  _linePrefix(line) {
    const t = line?.type || '';
    if (t === 'task')    return line.isTaskCompleted?.() ? '[x] ' : '[ ] ';
    if (t === 'ulist')   return '• ';
    if (t === 'olist')   return '1. ';
    if (t === 'heading') return '# ';
    if (t === 'quote')   return '> ';
    return '';
  }

  _appendSegments(container, segments) {
    for (const seg of segments || []) {
      if (!seg) continue;
      if (seg.type === 'text') {
        container.appendChild(document.createTextNode(typeof seg.text === 'string' ? seg.text : ''));
      } else if (seg.type === 'bold') {
        const el = document.createElement('strong'); el.textContent = typeof seg.text === 'string' ? seg.text : ''; container.appendChild(el);
      } else if (seg.type === 'italic') {
        const el = document.createElement('em'); el.textContent = typeof seg.text === 'string' ? seg.text : ''; container.appendChild(el);
      } else if (seg.type === 'code') {
        const el = document.createElement('code'); el.textContent = typeof seg.text === 'string' ? seg.text : ''; container.appendChild(el);
      } else if (seg.type === 'ref') {
        const el = document.createElement('span'); el.className = 'tn-seg-ref';
        el.textContent = seg.text?.title || this._resolveRecordName(seg.text?.guid) || '[link]'; container.appendChild(el);
      } else if (seg.type === 'link' || seg.type === 'linkobj') {
        const url = typeof seg.text === 'string' ? seg.text : (seg.text?.link || '');
        const a   = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.className = 'tn-seg-link'; a.textContent = seg.text?.title || url; container.appendChild(a);
      } else if (typeof seg.text === 'string' && seg.text) {
        container.appendChild(document.createTextNode(seg.text));
      }
    }
  }

  _resolveRecordName(guid) {
    try { return this.data.getRecord?.(guid)?.getName?.() || null; } catch (_) { return null; }
  }

  // =========================================================================
  // Data fetching
  // =========================================================================

  async _getRecordsForDate(yyyymmdd, onProgress) {
    const sig = this._settingsCacheSignature();
    const cacheKey = `${yyyymmdd}::${sig}`;
    const now = Date.now();
    const hit = this._recordsByDateCache?.get?.(cacheKey);
    if (hit && (now - hit.ts) < TN_QUERY_CACHE_TTL_MS && Array.isArray(hit.results)) {
      return hit.results.map((x) => ({ ...x }));
    }

    const y = parseInt(yyyymmdd.slice(0,4), 10);
    const m = parseInt(yyyymmdd.slice(4,6), 10) - 1;
    const d = parseInt(yyyymmdd.slice(6,8), 10);
    const dayStart = new Date(y, m, d,  0,  0,  0,   0);
    const dayEnd   = new Date(y, m, d, 23, 59, 59, 999);

    const excludedSet  = new Set(this._settings.excludedCollections.map(n => n.toLowerCase()));
    const journalNames = new Set(['journal', 'journals']);
    const collections  = await this.data.getAllCollections();

    const toScan = [];
    for (const coll of collections || []) {
      const name = coll.getName() || '';
      if (!name) continue;
      if (journalNames.has(name.toLowerCase())) continue;
      if (excludedSet.has(name.toLowerCase())) continue;
      toScan.push({ coll, name });
    }

    const results = [];
    const total = toScan.length;
    for (let i = 0; i < toScan.length; i++) {
      const { coll, name } = toScan[i];
      if (onProgress) {
        try { onProgress(total ? `Scanning collections… ${i + 1}/${total}` : 'Scanning collections…'); } catch (_) {}
      }
      await new Promise((r) => setTimeout(r, 0));

      let records;
      try { records = await coll.getAllRecords(); } catch (_) { continue; }

      const collIcon = this._collectionIconName(coll);
      for (const record of records) {
        const dateVal = this._getDateFieldValue(record);
        if (!dateVal) continue;
        if (dateVal >= dayStart && dateVal <= dayEnd) {
          results.push({ record, collectionName: name, dateVal, collectionIcon: collIcon });
        }
      }
    }
    const mode = this._mainSortMode();
    if (mode === 'chrono') {
      results.sort((a, b) => {
        const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
        const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
        if (ta !== tb) return ta - tb;
        return String(a.collectionName || '').localeCompare(String(b.collectionName || ''));
      });
    } else {
      results.sort((a, b) => {
        const c = a.collectionName.localeCompare(b.collectionName);
        return c !== 0 ? c : a.dateVal - b.dateVal;
      });
    }

    try { this._recordsByDateCache.set(cacheKey, { ts: now, results }); } catch (_) {}
    return results;
  }

  _getDateFieldValue(record) {
    const fields = this._settings.dateFields.length > 0 ? this._settings.dateFields : ['When', 'when'];
    for (const propName of fields) {
      try {
        const prop = record.prop(propName);
        if (!prop) continue;
        if (typeof prop.date === 'function') { const d = prop.date(); if (d instanceof Date && !isNaN(d)) return d; }
        const raw = prop.get();
        if (!raw) continue;
        if (raw instanceof Date && !isNaN(raw)) return raw;
        if (typeof raw.toDate === 'function') { const d = raw.toDate(); if (d instanceof Date && !isNaN(d)) return d; }
        if (typeof raw.value === 'function')  { const d = new Date(raw.value()); if (!isNaN(d)) return d; }
        if (typeof raw === 'number')          { const d = new Date(raw); if (!isNaN(d)) return d; }
        if (typeof raw === 'string' && raw.length >= 8) { const d = new Date(raw); if (!isNaN(d)) return d; }
      } catch (_) {}
    }
    return null;
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  /** YYYYMMDD for real journal pages only — do not infer from record GUID (false positives on normal notes). */
  _journalDayKeyFromRecord(record) {
    if (!record) return null;
    try {
      const date = record.getJournalDetails?.()?.date;
      if (date instanceof Date && !isNaN(date.getTime())) {
        const y = String(date.getFullYear());
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}${m}${d}`;
      }
    } catch (_) {}
    return null;
  }

  _loadBool(key, def) {
    try { const v = localStorage.getItem(key); return v === null ? def : v === 'true'; } catch (_) { return def; }
  }
  _saveBool(key, val) {
    try { localStorage.setItem(key, val ? 'true' : 'false'); } catch (_) {}
    globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => [TN_SETTINGS_KEY, 'tn_footer_collapsed']);
  }


  _cfgLabel(title, subtitle) {
    const wrap = document.createElement('div'); wrap.style.cssText = 'margin-bottom:10px;';
    const t = document.createElement('div'); t.textContent = title;
    t.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted,#8a7e6a);margin-bottom:4px;';
    wrap.appendChild(t);
    if (subtitle) {
      const s = document.createElement('div'); s.textContent = subtitle;
      s.style.cssText = 'font-size:12px;color:var(--text-muted,#8a7e6a);';
      wrap.appendChild(s);
    }
    return wrap;
  }

  _injectCSS() {
    /* Scope every rule under .tn-footer. Shared tlr-* class names match Thymer's journal
       line UI; global rules were leaking into the editor (wrong bullets / layout). */
    this.ui.injectCSS(`
      .tn-footer {
        margin-top: 16px;
        font-size: 13px;
        color: #e8e0d0;
        background-color: rgba(40, 40, 48, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        padding: 12px 16px 10px;
        transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease, padding 0.2s ease;
      }
      .tn-footer:not(.tn-footer--suite-embed).tn-footer--collapsed {
        background-color: rgba(18, 18, 22, 0.52);
        border-color: rgba(255, 255, 255, 0.06);
        color: rgba(232, 224, 208, 0.82);
        padding: 8px 16px 8px;
      }
      .tn-footer .tn-header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        margin-bottom: 8px;
      }
      .tn-footer.tn-footer--collapsed .tn-header {
        margin-bottom: 0;
        min-height: 26px;
      }
      .tn-footer .tn-calendar-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex-shrink: 0;
        padding: 0;
        line-height: 0;
        color: #d4cdc2;
        border-radius: 6px;
      }
      .tn-footer .tn-calendar-toggle:hover {
        color: #f0ebe3;
        background: rgba(255, 255, 255, 0.08);
      }
      .tn-footer.tn-footer--collapsed .tn-calendar-toggle {
        color: #8a7e6a;
      }
      .tn-footer.tn-footer--collapsed .tn-calendar-toggle:hover {
        color: #c9c0b4;
      }
      .tn-footer .tn-collapsed-sections-wrap {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        justify-content: flex-end;
        flex: 1;
        min-width: 0;
      }
      .tn-footer .tn-collapsed-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.12);
        color: #8a7e6a;
        flex-shrink: 0;
      }
      .tn-footer .tn-collapsed-chip:hover {
        background: rgba(255,255,255,0.06);
        color: #e8e0d0;
      }
      .tn-footer .tn-collapsed-chip-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      .tn-footer .tn-header-tri,
      .jfs-tn-extras .tn-header-tri {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
        margin-left: 2px;
      }
      .tn-footer .tn-header-tri button,
      .jfs-tn-extras .tn-header-tri button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        flex-shrink: 0;
        padding: 0;
        line-height: 0;
        color: #8a7e6a;
        transition: color 0.15s ease, opacity 0.15s ease;
      }
      .tn-footer .tn-header-tri .tn-tri-lit,
      .jfs-tn-extras .tn-header-tri .tn-tri-lit {
        color: #e8e0d0;
        opacity: 1;
      }
      .tn-footer .tn-header-tri .tn-tri-dim,
      .jfs-tn-extras .tn-header-tri .tn-tri-dim {
        color: #8a7e6a;
        opacity: 0.42;
      }
      .tn-footer .tn-header-tri .tn-tri-dim:hover,
      .jfs-tn-extras .tn-header-tri .tn-tri-dim:hover {
        opacity: 0.85;
        color: #e8e0d0;
      }
      .tn-footer .tn-header-tri-divider,
      .jfs-tn-extras .tn-header-tri-divider {
        display: inline-block;
        width: 1px;
        height: 14px;
        margin: 0 5px 0 5px;
        background: rgba(232, 224, 208, 0.2);
        flex-shrink: 0;
        align-self: center;
      }
      .tn-footer .tn-chrono-body {
        padding-left: 2px;
      }
      .tn-footer .tn-section {
        margin-top: 10px;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 8px;
      }
      .tn-footer .tn-section:first-of-type { margin-top: 0; border-top: none; padding-top: 0; }
      .tn-footer .tn-section-head { margin-bottom: 6px; }
      .tn-footer .tn-section-head-inner {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
      }
      .tn-footer .tn-section-icon {
        display: inline-flex;
        align-items: center;
        color: #8a7e6a;
        flex-shrink: 0;
      }
      .tn-footer .tn-section-title {
        flex: 1;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: #8a7e6a;
      }
      .tn-footer .tn-section-collapse-btn {
        color: #8a7e6a;
        padding: 0 4px;
        font-size: 14px;
        flex-shrink: 0;
      }
      .tn-footer .tn-section-collapse-btn:hover { color: #e8e0d0; }
      .tn-footer .tn-section-body { padding-left: 2px; }
      .tn-footer .tn-tm-section { border-top: 1px solid rgba(255,255,255,0.08); }
      .tn-footer .tn-tm-subcoll {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #8a7e6a;
        margin: 8px 0 4px;
      }
      .tn-footer .tn-tm-year-head {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(232,224,208,0.92);
        margin: 12px 0 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }
      .tn-footer .tn-tm-year-head:first-child { margin-top: 0; }
      .tn-footer .tn-row-coll-strip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        max-width: 42%;
      }
      .tn-footer .tn-row-coll-ico {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #8a7e6a;
        flex-shrink: 0;
      }
      .tn-footer .tn-row-coll-name {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: #8a7e6a;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tn-footer .tn-collection-icon-emoji { font-size: 14px; line-height: 1; }
      .tn-footer .tn-header .tn-settings-btn {
        font-size: 13px;
        color: #8a7e6a;
        cursor: pointer;
        padding: 0 2px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, color 0.12s ease;
      }
      .tn-footer .tn-header:hover .tn-settings-btn,
      .tn-footer .tn-header:focus-within .tn-settings-btn {
        opacity: 1;
        pointer-events: auto;
      }
      .tn-footer .tn-header .tn-settings-btn:hover { color: #e8e0d0; }
      .tn-footer .tn-body { padding-bottom: 4px; }
      .tn-footer .tn-loading, .tn-footer .tn-empty {
        font-size: 12px;
        color: #8a7e6a;
        padding: 4px 0 6px;
        font-style: italic;
      }
      .tn-footer .tn-record-group {
        margin: 0 -6px;
        border-radius: 6px;
        margin-bottom: 2px;
      }
      .tn-footer .tn-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 5px 6px;
        border-radius: 6px;
        transition: background 0.1s;
      }
      .tn-footer .tn-record-group:not(.tlr-record-expanded) .tn-row:hover { background: rgba(255,255,255,0.05); }
      .tn-footer .tn-record-group.tlr-record-expanded .tn-row { background: rgba(255,255,255,0.04); border-radius: 6px 6px 0 0; }
      .tn-footer .tn-record-name {
        flex: 1;
        min-width: 0;
        text-align: left;
        font-size: 13px;
        color: #e8e0d0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
        padding: 0;
      }
      .tn-footer .tn-record-name:hover { color: #fff; }
      .tn-footer .tn-arrow {
        opacity: 0;
        color: #8a7e6a;
        flex-shrink: 0;
        font-size: 12px;
        cursor: pointer;
        padding: 0;
        transition: opacity 0.1s;
      }
      .tn-footer .tn-row:hover .tn-arrow { opacity: 1; }
      .tn-footer .tn-arrow:hover { color: #e8e0d0; }

      .tn-footer .tlr-expand-record-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        min-width: 14px;
        height: 16px;
        padding: 0;
        font-size: 12px;
        color: #8a7e6a;
        cursor: pointer;
        border-radius: 0;
        margin: 0;
        background: none;
        border: none;
        font-weight: 600;
        line-height: 1;
        vertical-align: middle;
        flex-shrink: 0;
      }
      .tn-footer .tlr-expand-record-btn:hover { color: #e8e0d0; }
      .tn-footer .tlr-expand-record-btn.is-expanded { color: var(--color-primary-400,#c4b5fd); }

      .tn-footer .tlr-record-preview {
        display: none;
        flex-direction: column;
        margin: 0 0 6px 10px;
        border-left: 2px solid rgba(255,255,255,0.08);
        padding: 6px 8px 8px 12px;
        border-radius: 0 8px 8px 0;
        background: rgba(0,0,0,0.12);
        font-family: var(--font-text, var(--font-family, inherit));
        font-size: var(--font-size-body, 13px);
        line-height: 1.45;
        color: var(--color-text-100, #e8e0d0);
      }
      .tn-footer .tlr-record-expanded .tlr-record-preview { display: flex; }
      .tn-footer .tlr-expand-loading, .tn-footer .tlr-expand-empty {
        font-style: italic;
        color: #8a7e6a;
        font-size: 12px;
        padding: 4px 0;
      }

      .tn-footer .tlr-preview-node {
        display: flex;
        flex-direction: column;
      }
      .tn-footer .tlr-preview-row {
        display: flex;
        align-items: center;
        gap: 2px;
        padding-left: calc(var(--tlr-depth, 0) * 16px);
      }
      .tn-footer .tlr-preview-toggle {
        width: 14px;
        min-width: 14px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        line-height: 1;
        color: #8a7e6a;
        padding: 0;
        cursor: pointer;
        font-size: 8px;
        transition: color 0.1s;
      }
      .tn-footer .tlr-preview-toggle:hover { color: #e8e0d0; }
      .tn-footer .tlr-preview-spacer { width: 14px; min-width: 14px; flex-shrink: 0; display: inline-block; }
      .tn-footer .tlr-preview-children { display: flex; flex-direction: column; }
      .tn-footer .tlr-preview-children.is-hidden { display: none; }
      .tn-footer .tlr-expand-line {
        flex: 1;
        min-width: 0;
        text-align: left;
        padding: 4px 6px;
        font-size: var(--font-size-body, 13px);
        color: var(--color-text-100, #e8e0d0);
        line-height: 1.45;
        border-radius: 4px;
        word-break: break-word;
        cursor: pointer;
      }
      .tn-footer .tlr-expand-line:hover { background: rgba(255,255,255,0.05); color: #e8e0d0; }

      .tn-footer .tn-prefix { color: #8a7e6a; font-size: 11px; flex-shrink: 0; margin-right: 2px; }
      .tn-footer .tn-line-content strong { color: #e8e0d0; }
      .tn-footer .tn-line-content em { opacity: 0.8; }
      .tn-footer .tn-line-content code { font-family: monospace; font-size: 11px; background: rgba(255,255,255,0.06); padding: 0 3px; border-radius: 3px; }
      .tn-footer .tn-seg-ref  { color: var(--color-primary-400,#c4b5fd); }
      .tn-footer .tn-seg-link { color: var(--color-primary-400,#c4b5fd); text-decoration: none; }
      .tn-footer .tn-seg-link:hover { text-decoration: underline; }

      .tn-footer.tn-footer--suite-embed {
        margin-top: 0;
        margin-bottom: 0;
        width: 100%;
        max-width: none;
        align-self: stretch;
        flex: 0 0 auto;
        min-width: 0;
        min-height: 0;
        box-sizing: border-box;
        background: transparent;
        border: none;
        border-radius: 0;
        padding: 0;
        box-shadow: none;
        -webkit-backdrop-filter: none;
        backdrop-filter: none;
      }
      .tn-footer.tn-footer--suite-embed .tn-body {
        width: 100%;
        min-width: 0;
      }
    `);
  }
}
