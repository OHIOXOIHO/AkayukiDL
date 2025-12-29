// ==UserScript==
// @name         Akayuki Assistant
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  Check anime availability in Akayuki bot on MAL and AniList.
// @author       https://t.me/AkaAnimeBot
// @match        https://myanimelist.net/*
// @match        https://anilist.co/*
// @connect      akayukidl.top
// @connect      graphql.anilist.co
// @grant        GM_addStyle
// @icon         https://akayukidl.top/favicon.ico
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ---------------------------------------------------
    // INJECT CSS
    // ---------------------------------------------------
    const cssStyles = `
        /* --- General Styles --- */
        .akayuki-badge-container {
            display: inline-block;
            vertical-align: middle;
            margin-left: 8px;
            z-index: 100;
            position: relative;
            line-height: 1;
        }

        /* MAL Badge Style (Pill-shaped and clean) */
        .akayuki-badge-mal {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 18px;
            padding: 0 8px;
            border-radius: 9px;
            font-size: 10px;
            font-family: 'Segoe UI', sans-serif;
            font-weight: 700;
            color: white;
            text-transform: uppercase;
            cursor: default;
            box-shadow: 0 1px 2px rgba(0,0,0,0.15);
            transition: transform 0.1s;
            line-height: 1;
            white-space: nowrap;
        }

        .akayuki-badge-mal:hover {
            transform: scale(1.05);
        }

        /* AniList Badge Style (On cover - Glassmorphism) */
        .akayuki-cover-badge {
            position: absolute;
            top: 6px;
            left: 6px;
            z-index: 50;
            min-width: 24px;
            height: 24px;
            padding: 0 6px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 800;
            font-family: sans-serif;
            color: white;
            
            /* Glass effect */
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s;
        }

        .akayuki-cover-badge:hover {
            transform: scale(1.1);
            background: rgba(0, 0, 0, 0.8);
        }

        /* Status Colors */
        .status-wait { background: #64748b; opacity: 0.8; }
        .status-checking { background: #3b82f6; animation: pulse 1s infinite; }
        .status-exist { background: #10b981; cursor: pointer; }
        .status-missing { background: #e11d48; cursor: pointer; }

        /* Cover specific colors (more transparent) */
        .akayuki-cover-badge.status-exist { background: rgba(16, 185, 129, 0.85); border-color: rgba(16, 185, 129, 0.5); }
        .akayuki-cover-badge.status-missing { background: rgba(225, 29, 72, 0.85); border-color: rgba(225, 29, 72, 0.5); }

        /* Copy Button */
        .akayuki-copy-btn {
            display: inline-block;
            margin-left: 6px;
            padding: 2px 6px;
            border-radius: 4px;
            background: #f1f5f9;
            border: 1px solid #cbd5e1;
            color: #475569;
            font-size: 9px;
            font-weight: bold;
            cursor: pointer;
            vertical-align: middle;
        }
        .akayuki-copy-btn:hover {
            background: #e2e8f0;
            color: #0f172a;
        }

        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.6; transform: scale(0.95); }
            100% { opacity: 1; transform: scale(1); }
        }

        /* Single Page Status Box Style */
        .akayuki-status-box {
            padding: 12px;
            margin-bottom: 15px;
            border-radius: 8px;
            color: white;
            text-align: center;
            font-weight: 700;
            font-family: sans-serif;
            cursor: pointer;
            background-color: #64748b;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
    `;
    GM_addStyle(cssStyles);

    // ---------------------------------------------------
    // MAIN LOGIC
    // ---------------------------------------------------
    const API_BASE_URL = "https://akayukidl.top/api/animes";
    const STATUS_CACHE_KEY = "akayuki_status_cache_v5"; 
    const ID_MAP_CACHE_KEY = "akayuki_id_map_cache_v3";

    const SERVER_BATCH_INTERVAL = 1100; 
    const ANILIST_BATCH_INTERVAL = 2000; 

    const TTL_FOUND = 7 * 24 * 60 * 60 * 1000; 
    const TTL_MISSING = 60 * 60 * 1000;        

    console.log("Akayuki Extension: v1.6");

    let serverQueue = [];
    let aniListQueue = [];
    let serverTimer = null;
    let aniListTimer = null;
    let elementMap = new Map();

    const IS_ANILIST = window.location.hostname.includes('anilist.co');
    const IS_MAL = window.location.hostname.includes('myanimelist.net');

    // === Faster Navigation Handling (SPA Support) ===
    let lastUrl = location.href;
    
    // Check immediatly on load
    setTimeout(runAkayuki, 100);

    // Override history methods to detect SPA navigation instantly
    const originalPushState = history.pushState;
    history.pushState = function() {
        originalPushState.apply(this, arguments);
        checkUrlChange();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function() {
        originalReplaceState.apply(this, arguments);
        checkUrlChange();
    };

    window.addEventListener('popstate', checkUrlChange);

    function checkUrlChange() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            runAkayuki(); // Run immediately when URL changes
        }
    }
    // ========================================

    let observerTimeout;
    const observer = new MutationObserver((mutations) => {
        // Also check URL on mutation just in case
        checkUrlChange();

        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            runAkayuki();
        }, 200); // Reduced from 500ms to 200ms for snappier response
    });
    observer.observe(document.body, { childList: true, subtree: true });

    function runAkayuki() {
        // Cleanup if not on anime page
        if (!isAnimePage()) {
            cleanupBadges();
            return;
        }

        if (IS_MAL) {
            handleMalList();
            handleMalSingle();
        } else if (IS_ANILIST) {
            handleAniListList();
            handleAniListSingle();
        }
    }

    // Check if current URL is related to Anime
    function isAnimePage() {
        const url = window.location.href;
        if (IS_ANILIST) {
            // AniList: /anime/... or /search/anime
            return url.includes('/anime/') || url.includes('/search/anime');
        } else if (IS_MAL) {
            // MAL: /anime/... or /topanime.php
            return url.includes('/anime/') || url.includes('/anime.php') || url.includes('topanime.php');
        }
        return false;
    }

    // Remove badges if user navigates away from anime pages (e.g. to Manga)
    function cleanupBadges() {
        const boxes = document.querySelectorAll('.akayuki-status-box');
        boxes.forEach(box => box.remove());
        
        // Optional: Remove list badges too if needed
        // const badges = document.querySelectorAll('.akayuki-badge-container, .akayuki-cover-badge');
        // badges.forEach(b => b.remove());
    }

    // ---------------------------------------------------
    // CACHING HELPERS
    // ---------------------------------------------------
    function getCache(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
    }
    function setCache(key, data) {
        try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
    }

    function getStatusFromCache(malId) {
        const cache = getCache(STATUS_CACHE_KEY);
        const entry = cache[malId];
        if (!entry) return undefined;
        if (Date.now() > entry.e) {
            delete cache[malId];
            setCache(STATUS_CACHE_KEY, cache);
            return undefined; 
        }
        return entry.v; 
    }

    function cacheStatus(ids, exists) { 
        const cache = getCache(STATUS_CACHE_KEY);
        const now = Date.now();
        const ttl = exists ? TTL_FOUND : TTL_MISSING;
        const expiry = now + ttl;
        const val = exists ? 1 : 0;
        ids.forEach(id => { cache[id] = { v: val, e: expiry }; });
        setCache(STATUS_CACHE_KEY, cache);
    }

    function getCachedMalId(alId) { return getCache(ID_MAP_CACHE_KEY)[alId]; }
    function cacheMalId(alId, malId) {
        const cache = getCache(ID_MAP_CACHE_KEY);
        cache[alId] = malId;
        setCache(ID_MAP_CACHE_KEY, cache);
    }

    // ---------------------------------------------------
    // 1. ANILIST BULK RESOLVER
    // ---------------------------------------------------
    function addToAniListQueue(item) {
        if (elementMap.has(`al_${item.alId}`)) return;

        const cachedId = getCachedMalId(item.alId);
        if (cachedId) {
            item.malId = cachedId;
            addToServerQueue(item); 
            return;
        }

        aniListQueue.push(item.alId);
        if (!elementMap.has(`al_${item.alId}`)) elementMap.set(`al_${item.alId}`, []);
        elementMap.get(`al_${item.alId}`).push(item);

        if (item.element) item.element.innerText = '...';
        if (!aniListTimer) aniListTimer = setTimeout(processAniListBatch, ANILIST_BATCH_INTERVAL);
    }

    async function processAniListBatch() {
        if (aniListQueue.length === 0) { aniListTimer = null; return; }

        const batchAlIds = [...new Set(aniListQueue.splice(0, 50))];
        const query = `query ($ids: [Int]) { Page { media(id_in: $ids, type: ANIME) { id idMal } } }`;

        try {
            const resp = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query, variables: { ids: batchAlIds } })
            });

            if (resp.status === 429) {
                aniListQueue.unshift(...batchAlIds);
                setTimeout(processAniListBatch, 10000);
                return;
            }

            const data = await resp.json();
            const results = data.data?.Page?.media || [];

            results.forEach(media => {
                const alId = media.id;
                const malId = media.idMal;

                if (malId) {
                    cacheMalId(alId, malId);
                    const items = elementMap.get(`al_${alId}`) || [];
                    items.forEach(item => {
                        item.malId = malId;
                        addToServerQueue(item);
                    });
                } else {
                    const items = elementMap.get(`al_${alId}`) || [];
                    items.forEach(item => updateStatus(item, false, true));
                }
                elementMap.delete(`al_${alId}`); 
            });
        } catch (e) { console.error(e); }

        if (aniListQueue.length > 0) aniListTimer = setTimeout(processAniListBatch, ANILIST_BATCH_INTERVAL);
        else aniListTimer = null;
    }

    // ---------------------------------------------------
    // 2. SERVER BULK CHECKER
    // ---------------------------------------------------
    function addToServerQueue(item) {
        const malId = parseInt(item.malId);
        if (!malId) return;

        const cachedStatus = getStatusFromCache(malId);
        if (cachedStatus !== undefined) {
            updateStatus(item, cachedStatus === 1);
            return;
        }

        if (elementMap.has(`mal_${malId}`)) {
            elementMap.get(`mal_${malId}`).push(item);
            return; 
        }

        serverQueue.push(malId);
        elementMap.set(`mal_${malId}`, [item]);

        if (item.element) {
            item.element.classList.remove('status-wait');
            item.element.classList.add('status-checking');
        }

        if (!serverTimer) serverTimer = setTimeout(processServerBatch, SERVER_BATCH_INTERVAL);
    }

    async function processServerBatch() {
        if (serverQueue.length === 0) { serverTimer = null; return; }

        const batchIds = [...new Set(serverQueue.splice(0, 50))];

        try {
            const resp = await fetch(`${API_BASE_URL}/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(batchIds)
            });

            if (resp.status === 429) {
                serverQueue.unshift(...batchIds);
                setTimeout(processServerBatch, 5000);
                return;
            }

            if (resp.status === 200) {
                const data = await resp.json();
                const existingIds = new Set(data.existing_ids);
                
                const foundList = [];
                const missingList = [];

                batchIds.forEach(id => {
                    if (existingIds.has(id)) foundList.push(id);
                    else missingList.push(id);
                });

                cacheStatus(foundList, true);  
                cacheStatus(missingList, false); 

                batchIds.forEach(id => {
                    const items = elementMap.get(`mal_${id}`) || [];
                    const exists = existingIds.has(id);
                    items.forEach(item => updateStatus(item, exists));
                    elementMap.delete(`mal_${id}`);
                });
            }
        } catch (e) {
            batchIds.forEach(id => {
                const items = elementMap.get(`mal_${id}`) || [];
                items.forEach(item => { if(item.element) item.element.innerText = 'Err'; });
                elementMap.delete(`mal_${id}`);
            });
        }

        if (serverQueue.length > 0) serverTimer = setTimeout(processServerBatch, SERVER_BATCH_INTERVAL);
        else serverTimer = null;
    }

    // ---------------------------------------------------
    // UI & HELPERS
    // ---------------------------------------------------
    function updateStatus(item, exists, noMalId = false) {
        if (!item.element) return;
        
        item.element.classList.remove('status-checking', 'status-wait');
        
        const botUrl = item.malId ? `https://t.me/AkaAnimebot?start=dl_${item.malId}` : 'https://t.me/AkaAnimebot';
        
        const clickHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            if (exists) {
                window.open(botUrl, '_blank');
            } else {
                navigator.clipboard.writeText(item.title);
                const originalText = item.element.innerText;
                if (item.isBox) item.element.innerText = '📋 Copied!';
                else item.element.innerText = 'Copied';
                
                if (!item.isBox) item.element.style.fontSize = '9px';
                
                setTimeout(() => {
                    item.element.innerText = originalText;
                    if (!item.isBox) item.element.style.fontSize = ''; 
                }, 1500);
            }
        };

        if (exists) {
            item.element.classList.add('status-exist');
            item.element.classList.remove('status-missing');
            item.element.innerText = item.isBox ? 'DOWNLOAD' : 'DL';
            item.element.title = "Download via Bot";
            if(item.isBox) item.element.style.backgroundColor = '#10b981';
        } else {
            item.element.classList.add('status-missing');
            item.element.classList.remove('status-exist');
            item.element.innerText = item.isBox ? 'NOT FOUND' : (noMalId ? '?' : 'NA');
            item.element.title = noMalId ? "No MAL ID" : "Not Found. Click to Copy Name.";
            if(item.isBox) item.element.style.backgroundColor = '#e11d48';
        }
        
        item.element.onclick = clickHandler;
    }

    // ---------------------------------------------------
    // DOM HANDLERS
    // ---------------------------------------------------
    function handleAniListList() {
        const cards = document.querySelectorAll('.media-card');
        cards.forEach(card => {
            if (card.querySelector('.akayuki-cover-badge')) return;
            const link = card.querySelector('a.cover') || card.querySelector('a.image-link');
            if (!link) return;

            const href = link.getAttribute('href');
            // Only allow ANIME links
            if (!href || !href.includes('/anime/')) return;
            
            const match = href.match(/anime\/(\d+)/);
            if (match) {
                const alId = parseInt(match[1]);
                const titleEl = card.querySelector('.title');
                const title = titleEl ? titleEl.innerText : 'Anime';
                const badge = document.createElement('div');
                badge.className = 'akayuki-cover-badge status-wait';
                badge.innerText = '...';
                badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
                const coverEl = card.querySelector('.cover') || link;
                if(getComputedStyle(coverEl).position === 'static') coverEl.style.position = 'relative';
                coverEl.appendChild(badge);
                addToAniListQueue({ alId, element: badge, title, type: 'anilist' });
            }
        });
    }

    function handleAniListSingle() {
        const match = window.location.href.match(/anime\/(\d+)/);
        // Important Check: If not on anime page, exit
        if (!match) return;

        const currentAlId = parseInt(match[1]);
        const sidebar = document.querySelector('.sidebar');
        
        if (!sidebar) return;

        const existingBox = document.querySelector('.akayuki-status-box');
        if (existingBox) {
            if (parseInt(existingBox.dataset.id) !== currentAlId) {
                existingBox.remove();
            } else {
                return;
            }
        }

        const box = document.createElement('div');
        box.className = 'akayuki-status-box';
        box.innerText = 'Checking...';
        box.dataset.id = currentAlId; 
        
        sidebar.insertBefore(box, sidebar.firstChild);
        const title = document.querySelector('h1')?.innerText.trim() || '';
        addToAniListQueue({ alId: currentAlId, element: box, title, isBox: true, type: 'anilist' });
    }

    function handleMalList() {
        const rows = document.querySelectorAll('tr.ranking-list');
        rows.forEach(row => {
            if (row.querySelector('.akayuki-badge-mal')) return;
            const titleHeader = row.querySelector('h3.anime_ranking_h3');
            if (!titleHeader) return;
            const link = titleHeader.querySelector('a');
            if (!link) return;
            
            // Only allow ANIME links
            if (!link.href.includes('/anime/')) return;
            
            const match = link.href.match(/anime\/(\d+)/);
            if (match) {
                const malId = parseInt(match[1]);
                const title = link.innerText;
                const badge = document.createElement('span');
                badge.className = 'akayuki-badge-mal status-wait';
                badge.innerText = '...'; 
                badge.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
                const container = document.createElement('span');
                container.className = 'akayuki-badge-container';
                container.appendChild(badge);
                titleHeader.style.display = 'flex'; 
                titleHeader.style.alignItems = 'center';
                titleHeader.appendChild(container);
                addToServerQueue({ malId, element: badge, title, type: 'mal' });
            }
        });
    }

    function handleMalSingle() {
        const match = window.location.href.match(/anime\/(\d+)/);
        // Important Check: If not on anime page, exit
        if (!match) return;

        const currentMalId = parseInt(match[1]);
        const leftSide = document.querySelector('.leftside') || document.querySelector('td.borderClass');
        
        if (!leftSide) return;

        const existingBox = document.querySelector('.akayuki-status-box');
        if (existingBox) {
            if (parseInt(existingBox.dataset.id) !== currentMalId) {
                existingBox.remove();
            } else {
                return;
            }
        }

        const box = document.createElement('div');
        box.className = 'akayuki-status-box';
        box.innerText = 'Checking...';
        box.dataset.id = currentMalId;

        leftSide.insertBefore(box, leftSide.firstChild);
        const title = document.querySelector('h1.title-name')?.innerText.trim() || '';
        addToServerQueue({ malId: currentMalId, element: box, title, isBox: true, type: 'mal' });
    }
})();
