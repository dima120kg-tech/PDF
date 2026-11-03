/* ============================================================
   Aero PDF — быстрый автономный просмотрщик
   PDF.js + IndexedDB + Service Worker + ленивая загрузка
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ---------- IndexedDB ----------
const DB_NAME = 'PDFLibrary';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

let db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) return resolve(db);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains(STORE_NAME)) {
                d.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function dbGetAll() {
    const d = await openDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbGet(id) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(doc) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(doc);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function dbDelete(id) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// ---------- Состояние ----------
let currentPdf = null;
let currentDocId = null;
let currentScale = 0.8;
let totalPages = 0;
let currentPage = 1;
let searchResults = [];
let searchResultIndex = -1;
let tocData = null;
let renderedPages = new Set();

// ---------- DOM ----------
const libraryView = document.getElementById('library-view');
const viewerView = document.getElementById('viewer-view');
const docList = document.getElementById('doc-list');
const fileInput = document.getElementById('file-input');
const themeToggle = document.getElementById('theme-toggle');

const docTitle = document.getElementById('doc-title');
const pdfPages = document.getElementById('pdf-pages');
const pdfContainer = document.getElementById('pdf-container');
const pageInput = document.getElementById('page-input');
const pageTotal = document.getElementById('page-total');
const loadingIndicator = document.getElementById('loading-indicator');

const tocPanel = document.getElementById('toc-panel');
const tocContent = document.getElementById('toc-content');
const searchPanel = document.getElementById('search-panel');
const searchInput = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
const searchNav = document.getElementById('search-nav');
const searchCounter = document.getElementById('search-counter');

// ---------- Тема ----------
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pdf-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀' : '◐';
}

function initTheme() {
    const saved = localStorage.getItem('pdf-theme');
    applyTheme(saved || 'dark');
}

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ---------- Библиотека ----------
async function renderLibrary() {
    const docs = await dbGetAll();
    docList.innerHTML = '';

    if (docs.length === 0) {
        docList.innerHTML = '<div class="toc-empty">Нет документов. Нажмите «Открыть PDF».</div>';
        return;
    }

    docs.sort((a, b) => b.addedAt - a.addedAt);

    for (const doc of docs) {
        const item = document.createElement('div');
        item.className = 'doc-item';

        const info = document.createElement('div');
        info.className = 'doc-info';
        info.innerHTML = `
            <div class="doc-name">${escapeHtml(doc.name)}</div>
            <div class="doc-meta">${formatSize(doc.size)} · ${new Date(doc.addedAt).toLocaleDateString('ru-RU')}</div>
        `;

        const actions = document.createElement('div');
        actions.className = 'doc-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'icon-btn';
        openBtn.textContent = '▶';
        openBtn.title = 'Открыть';
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDocument(doc.id);
        });

        const renameBtn = document.createElement('button');
        renameBtn.className = 'icon-btn';
        renameBtn.textContent = '✎';
        renameBtn.title = 'Переименовать';
        renameBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newName = prompt('Новое имя документа:', doc.name);
            if (newName && newName.trim() && newName.trim() !== doc.name) {
                doc.name = newName.trim();
                await dbPut(doc);
                renderLibrary();
            }
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn';
        delBtn.textContent = '🗑';
        delBtn.title = 'Удалить';
        delBtn.style.color = 'var(--danger)';
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm(`Удалить «${doc.name}»?`)) {
                await dbDelete(doc.id);
                renderLibrary();
            }
        });

        actions.appendChild(openBtn);
        actions.appendChild(renameBtn);
        actions.appendChild(delBtn);

        item.appendChild(info);
        item.appendChild(actions);

        item.addEventListener('click', () => openDocument(doc.id));

        docList.appendChild(item);
    }
}

// ---------- Импорт ----------
fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    loadingIndicator.classList.remove('hidden');
    loadingIndicator.textContent = 'Импорт…';

    for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;

        try {
            const buffer = await file.arrayBuffer();
            const doc = {
                id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2)),
                name: file.name.replace(/\.pdf$/i, ''),
                size: file.size,
                data: buffer,
                addedAt: Date.now()
            };
            await dbPut(doc);
        } catch (err) {
            console.error('Ошибка импорта:', err);
            alert(`Не удалось импортировать «${file.name}».`);
        }
    }

    loadingIndicator.classList.add('hidden');
    fileInput.value = '';
    renderLibrary();
});

// ---------- Открытие документа ----------
async function openDocument(id) {
    loadingIndicator.classList.remove('hidden');
    loadingIndicator.textContent = 'Открытие…';

    try {
        const doc = await dbGet(id);
        if (!doc) throw new Error('Документ не найден');

        currentDocId = id;
        docTitle.textContent = doc.name;

        let pdfData = doc.data;
        if (pdfData instanceof ArrayBuffer) {
            pdfData = new Uint8Array(pdfData);
        } else if (pdfData && pdfData.buffer) {
            pdfData = new Uint8Array(pdfData.buffer);
        }

        loadingIndicator.textContent = 'Чтение документа…';

        const loadingTask = pdfjsLib.getDocument({ data: pdfData });

        loadingTask.onProgress = (progress) => {
            if (progress.total) {
                const percent = Math.round((progress.loaded / progress.total) * 100);
                loadingIndicator.textContent = `Чтение ${percent}%…`;
            }
        };

        currentPdf = await loadingTask.promise;
        totalPages = currentPdf.numPages;
        currentPage = 1;
        pageTotal.textContent = `/ ${totalPages}`;
        pageInput.value = 1;
        currentScale = 0.8;

        try {
            tocData = await currentPdf.getOutline();
        } catch (e) {
            tocData = null;
        }

        // Переключаемся на просмотрщик ДО рендера, чтобы не было белого экрана
        libraryView.classList.remove('active');
        viewerView.classList.add('active');
        resetSearch();
        pdfContainer.scrollTop = 0;

        // Рендерим плейсхолдеры и первую страницу
        await renderAllPages();

    } catch (err) {
        console.error('openDocument ERROR:', err);
        alert('Не удалось открыть документ: ' + (err && err.message ? err.message : err));
        // Возвращаемся в библиотеку, если открытие не удалось
        viewerView.classList.remove('active');
        libraryView.classList.add('active');
    } finally {
        loadingIndicator.classList.add('hidden');
    }
}

// ---------- Рендеринг (ленивая загрузка) ----------
async function renderAllPages() {
    pdfPages.innerHTML = '';
    renderedPages.clear();

    for (let i = 1; i <= totalPages; i++) {
        const placeholder = document.createElement('div');
        placeholder.className = 'pdf-page-placeholder';
        placeholder.dataset.page = i;
        placeholder.style.cssText = `
            width: 100%;
            max-width: 900px;
            height: ${Math.round(window.innerHeight * 1.3)}px;
            margin: 0 auto 12px;
            background: #1a2230;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #4a9eff;
            font-size: 14px;
        `;
        placeholder.textContent = `Стр. ${i}`;
        pdfPages.appendChild(placeholder);
    }

    await renderPageIfNeeded(1);
    lazyLoad();
}

async function renderPageIfNeeded(pageNum) {
    if (renderedPages.has(pageNum)) return;
    if (!currentPdf) return;
    if (pageNum < 1 || pageNum > totalPages) return;

    renderedPages.add(pageNum);

    const placeholder = pdfPages.querySelector(`[data-page="${pageNum}"]`);
    if (!placeholder) return;

    try {
        const page = await currentPdf.getPage(pageNum);

        const maxDimension = 3000;
        let scale = currentScale;
        const base = page.getViewport({ scale: 1 });
        if (base.width * scale > maxDimension || base.height * scale > maxDimension) {
            scale = Math.min(maxDimension / base.width, maxDimension / base.height);
        }

        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.dataset.page = pageNum;
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        placeholder.replaceWith(canvas);
    } catch (err) {
        console.error('Ошибка рендера страницы', pageNum, err);
        placeholder.textContent = `Стр. ${pageNum} — ошибка`;
    }
}

function lazyLoad() {
    const placeholders = pdfPages.querySelectorAll('.pdf-page-placeholder');
    const containerRect = pdfContainer.getBoundingClientRect();

    for (const ph of placeholders) {
        const rect = ph.getBoundingClientRect();
        if (rect.top < containerRect.bottom + containerRect.height * 2 &&
            rect.bottom > containerRect.top - containerRect.height * 2) {
            const pageNum = parseInt(ph.dataset.page);
            if (!isNaN(pageNum)) renderPageIfNeeded(pageNum);
        }
    }
}

// ---------- Навигация по страницам ----------
function goToPage(num) {
    if (num < 1) num = 1;
    if (num > totalPages) num = totalPages;
    currentPage = num;
    pageInput.value = num;

    renderPageIfNeeded(num);

    const el = pdfPages.querySelector(`[data-page="${num}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

pageInput.addEventListener('change', () => {
    let val = parseInt(pageInput.value);
    if (isNaN(val)) val = 1;
    goToPage(val);
});

document.getElementById('btn-prev-page').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('btn-next-page').addEventListener('click', () => goToPage(currentPage + 1));

// ---------- Масштаб ----------
document.getElementById('btn-zoom-in').addEventListener('click', async () => {
    currentScale = Math.min(currentScale + 0.25, 3);
    renderedPages.clear();
    await renderAllPages();
});

document.getElementById('btn-zoom-out').addEventListener('click', async () => {
    currentScale = Math.max(currentScale - 0.25, 0.5);
    renderedPages.clear();
    await renderAllPages();
});

// Pinch-to-zoom (упрощённый — после жеста перерендер с новым масштабом)
let pinchStartDist = 0;
let pinchStartScale = 1;

pdfContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        pinchStartScale = currentScale;
    }
}, { passive: false });

pdfContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ratio = dist / pinchStartDist;
        const newScale = Math.max(0.5, Math.min(pinchStartScale * ratio, 3));
        pdfPages.style.transform = `scale(${newScale / currentScale})`;
        pdfPages.style.transformOrigin = 'top center';
    }
}, { passive: false });

pdfContainer.addEventListener('touchend', async (e) => {
    if (e.touches.length < 2 && pinchStartDist > 0) {
        const computed = parseFloat((pdfPages.style.transform.match(/scale\(([^)]+)\)/) || [])[1]) || 1;
        currentScale = Math.max(0.5, Math.min(currentScale * computed, 3));
        pdfPages.style.transform = '';
        pinchStartDist = 0;
        renderedPages.clear();
        await renderAllPages();
    }
});

// ---------- Оглавление ----------
document.getElementById('btn-toc').addEventListener('click', () => {
    renderTOC();
    tocPanel.classList.add('open');
    searchPanel.classList.remove('open');
});

document.getElementById('toc-close').addEventListener('click', () => {
    tocPanel.classList.remove('open');
});

async function renderTOC() {
    tocContent.innerHTML = '';

    if (!tocData || tocData.length === 0) {
        tocContent.innerHTML = '<div class="toc-empty">В этом документе нет встроенного оглавления.</div>';
        return;
    }

    function flatten(items, level = 1) {
        for (const item of items) {
            const div = document.createElement('div');
            div.className = `toc-item level-${Math.min(level, 3)}`;
            div.textContent = item.title || '(без названия)';
            div.addEventListener('click', async () => {
                try {
                    const dest = item.dest;
                    if (dest) {
                        let pageNum;
                        if (typeof dest === 'string') {
                            const ref = await currentPdf.getDestination(dest);
                            pageNum = await currentPdf.getPageIndex(ref[0]) + 1;
                        } else if (Array.isArray(dest)) {
                            pageNum = await currentPdf.getPageIndex(dest[0]) + 1;
                        }
                        if (pageNum) {
                            goToPage(pageNum);
                            tocPanel.classList.remove('open');
                        }
                    }
                } catch (err) {
                    console.error('Ошибка перехода:', err);
                }
            });
            tocContent.appendChild(div);

            if (item.items && item.items.length > 0) {
                flatten(item.items, level + 1);
            }
        }
    }

    flatten(tocData);
}

// ---------- Поиск ----------
document.getElementById('btn-search').addEventListener('click', () => {
    searchPanel.classList.add('open');
    tocPanel.classList.remove('open');
    searchInput.focus();
});

document.getElementById('search-close').addEventListener('click', () => {
    searchPanel.classList.remove('open');
});

document.getElementById('search-go').addEventListener('click', performSearch);
searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
});

async function performSearch() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query || !currentPdf) return;

    searchResultsEl.innerHTML = '<div class="toc-empty">Поиск…</div>';
    searchResults = [];
    searchResultIndex = -1;

    for (let i = 1; i <= totalPages; i++) {
        try {
            const page = await currentPdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ').toLowerCase();

            if (pageText.includes(query)) {
                const idx = pageText.indexOf(query);
                const start = Math.max(0, idx - 40);
                const end = Math.min(pageText.length, idx + query.length + 40);
                let snippet = pageText.slice(start, end);
                if (start > 0) snippet = '…' + snippet;
                if (end < pageText.length) snippet = snippet + '…';

                searchResults.push({
                    page: i,
                    snippet: snippet,
                    query: query
                });
            }
        } catch (e) {
            // пропускаем страницы с ошибками
        }
    }

    renderSearchResults();
}

function renderSearchResults() {
    searchResultsEl.innerHTML = '';

    if (searchResults.length === 0) {
        searchResultsEl.innerHTML = '<div class="toc-empty">Ничего не найдено.</div>';
        searchNav.classList.add('hidden');
        return;
    }

    searchNav.classList.remove('hidden');

    searchResults.forEach((res, idx) => {
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.dataset.index = idx;
        div.innerHTML = `
            <div class="page-ref">Стр. ${res.page}</div>
            <div class="snippet">${escapeHtml(res.snippet)}</div>
        `;
        div.addEventListener('click', () => {
            goToPage(res.page);
            highlightResult(idx);
        });
        searchResultsEl.appendChild(div);
    });

    highlightResult(0);
}

function highlightResult(idx) {
    if (idx < 0 || idx >= searchResults.length) return;
    searchResultIndex = idx;
    searchCounter.textContent = `${idx + 1} / ${searchResults.length}`;

    searchResultsEl.querySelectorAll('.search-result-item').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });

    const activeEl = searchResultsEl.querySelector('.search-result-item.active');
    if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
    }
}

document.getElementById('search-prev').addEventListener('click', () => {
    if (searchResultIndex > 0) {
        const res = searchResults[searchResultIndex - 1];
        goToPage(res.page);
        highlightResult(searchResultIndex - 1);
    }
});

document.getElementById('search-next').addEventListener('click', () => {
    if (searchResultIndex < searchResults.length - 1) {
        const res = searchResults[searchResultIndex + 1];
        goToPage(res.page);
        highlightResult(searchResultIndex + 1);
    }
});

function resetSearch() {
    searchInput.value = '';
    searchResults = [];
    searchResultIndex = -1;
    searchResultsEl.innerHTML = '';
    searchNav.classList.add('hidden');
}

// ---------- Возврат в библиотеку ----------
document.getElementById('btn-back').addEventListener('click', () => {
    viewerView.classList.remove('active');
    libraryView.classList.add('active');
    tocPanel.classList.remove('open');
    searchPanel.classList.remove('open');
    currentPdf = null;
    currentDocId = null;
    tocData = null;
    renderedPages.clear();
    pdfPages.innerHTML = '';
    renderLibrary();
});

// ---------- Отслеживание текущей страницы при скролле ----------
pdfContainer.addEventListener('scroll', () => {
    const canvases = pdfPages.querySelectorAll('.pdf-page-canvas, .pdf-page-placeholder');
    const containerRect = pdfContainer.getBoundingClientRect();
    const midY = containerRect.top + containerRect.height / 2;

    for (const el of canvases) {
        const rect = el.getBoundingClientRect();
        if (rect.top <= midY && rect.bottom >= midY) {
            const pageNum = parseInt(el.dataset.page);
            if (pageNum && pageNum !== currentPage) {
                currentPage = pageNum;
                pageInput.value = pageNum;
            }
            break;
        }
    }

    // Ленивая загрузка
    lazyLoad();
}, { passive: true });

// ---------- Утилиты ----------
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
}

// ---------- Инициализация ----------
async function init() {
    initTheme();
    await openDB();
    await renderLibrary();

    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register('sw.js');
            console.log('SW зарегистрирован');
        } catch (err) {
            console.error('Ошибка SW:', err);
        }
    }
}

// Ждём загрузки PDF.js (он с defer) перед стартом
window.addEventListener('load', init);
