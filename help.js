// help.js
window.initHelpCenter = async function() {

    // --- 1. TAB ROUTING LOGIC ---
    const tabs = ['docs', 'tickets', 'features'];
    let featureRequestsInitialized = false;
    tabs.forEach(tab => {
        const btn = document.getElementById(`tab-btn-${tab}`);
        const content = document.getElementById(`tab-content-${tab}`);
        if(!btn || !content) return;

        btn.addEventListener('click', () => {
            tabs.forEach(t => {
                document.getElementById(`tab-content-${t}`).classList.add('hidden');
                document.getElementById(`tab-content-${t}`).classList.remove('block');
                document.getElementById(`tab-btn-${t}`).className = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300';
            });
            content.classList.remove('hidden');
            content.classList.add('block');
            btn.className = 'tab-btn whitespace-nowrap py-4 px-1 border-b-2 font-bold text-sm border-emerald-500 text-emerald-600';

            if(tab === 'tickets') fetchTicketHistory();
            if(tab === 'features' && !featureRequestsInitialized && typeof window.initFeatureRequests === 'function') {
                featureRequestsInitialized = true;
                window.initFeatureRequests();
            }
        });
    });

    // --- 2. KNOWLEDGE BASE ENGINE ---
    const grid = document.getElementById('help-grid');
    const searchInput = document.getElementById('help-search-input');
    const filterButtons = document.querySelectorAll('.filter-btn');
    let allArticles = [];

    if (grid) {
        const slugify = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const excerpt = md => md.replace(/#{1,6}\s+/g, '').replace(/[*_`[\]]/g, '').replace(/\n+/g, ' ').trim().slice(0, 140);

        try {
            const res = await fetch('/.netlify/functions/get-help-articles');
            if (res.ok) {
                const data = await res.json();
                allArticles = data.articles || [];
                renderArticles(allArticles);
            }
        } catch (e) {
            grid.innerHTML = `<div class="col-span-full text-center text-red-500">Failed to load documentation.</div>`;
        }

        function renderArticles(articles) {
            if (articles.length === 0) {
                grid.innerHTML = `<div class="col-span-full py-12 text-center text-gray-500 font-medium">No documentation records match your criteria.</div>`;
                return;
            }
            grid.innerHTML = articles.map(article => `
                <button type="button" data-article-id="${article.id}"
                   class="text-left bg-white rounded-2xl border border-gray-200 shadow-sm p-6 hover:shadow-md hover:border-emerald-300 transition flex flex-col h-full">
                    <div class="flex justify-between items-start mb-4">
                        <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">${article.category}</span>
                    </div>
                    <h3 class="text-lg font-bold text-gray-900 mb-2">${article.title}</h3>
                    <p class="text-sm text-gray-500 mb-6 flex-grow line-clamp-3">${excerpt(article.contentMd)}</p>
                    <span class="text-xs font-semibold text-emerald-700">Read article →</span>
                </button>
            `).join('');

            grid.querySelectorAll('[data-article-id]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const article = allArticles.find(a => String(a.id) === btn.dataset.articleId);
                    if (article) showArticleInline(article);
                });
            });
        }

        // --- Inline article reader (merged from help.html so articles open in-workspace) ---
        const listMode    = document.getElementById('help-list-mode');
        const articleView = document.getElementById('help-article-view');
        const backBtn     = document.getElementById('help-article-back');

        function showArticleInline(article) {
            document.getElementById('help-article-category').textContent = article.category || '';
            document.getElementById('help-article-title').textContent = article.title;

            // Render Markdown safely (marked + DOMPurify loaded in workspace.html <head>)
            let html = article.contentMd;
            if (window.marked && window.DOMPurify) {
                marked.setOptions({ breaks: false, gfm: true });
                html = DOMPurify.sanitize(marked.parse(article.contentMd));
            }
            document.getElementById('help-article-body').innerHTML = html;

            if (listMode) listMode.classList.add('hidden');
            if (articleView) articleView.classList.remove('hidden');
            window.scrollTo(0, 0);
        }

        function showArticleList() {
            if (articleView) articleView.classList.add('hidden');
            if (listMode) listMode.classList.remove('hidden');
        }

        if (backBtn) backBtn.addEventListener('click', showArticleList);

        let currentCategory = 'All';
        let currentSearch = '';

        function filterData() {
            const filtered = allArticles.filter(a => {
                const matchesCategory = currentCategory === 'All' || a.category === currentCategory;
                const matchesSearch = a.title.toLowerCase().includes(currentSearch) || a.contentMd.toLowerCase().includes(currentSearch);
                return matchesCategory && matchesSearch;
            });
            renderArticles(filtered);
        }

        if (searchInput) searchInput.addEventListener('input', (e) => { currentSearch = String(e.target.value).toLowerCase(); filterData(); });

        if (filterButtons) {
            filterButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    filterButtons.forEach(b => b.className = "px-4 py-2 rounded-full text-sm font-medium bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 transition filter-btn");
                    const target = e.currentTarget;
                    target.className = "px-4 py-2 rounded-full text-sm font-bold bg-emerald-50 text-emerald-700 border border-emerald-100 transition filter-btn";
                    currentCategory = target.getAttribute('data-category') || 'All';
                    filterData();
                });
            });
        }
    }

    // --- 3. SUPPORT TICKET ENGINE ---
    const ticketForm = document.getElementById('support-ticket-form');
    const historyBody = document.getElementById('ticket-history-body');

    async function fetchTicketHistory() {
        if(!historyBody) return;
        try {
            const res = await fetch('/.netlify/functions/support-tickets');
            if(res.ok) {
                const tickets = await res.json();
                renderTicketHistory(tickets);
            }
        } catch (e) {
            historyBody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-red-500">Failed to load history.</td></tr>`;
        }
    }

    function renderTicketHistory(tickets) {
        if(tickets.length === 0) {
            historyBody.innerHTML = `<tr><td colspan="4" class="p-8 text-center text-gray-500">You haven't submitted any support tickets yet.</td></tr>`;
            return;
        }

        const getStatusBadge = (status) => {
            const badges = {
                'open': `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Open</span>`,
                'pending': `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">Pending</span>`,
                'resolved': `<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-md text-xs font-bold bg-gray-100 text-gray-600 border border-gray-200">Resolved</span>`
            };
            return badges[status] || badges['open'];
        };

        historyBody.innerHTML = tickets.map(ticket => {
            const dateStr = new Date(ticket.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            return `
                <tr class="hover:bg-gray-50 transition-colors">
                    <td class="px-6 py-4 font-mono text-xs text-gray-500">#TK-${ticket.id}</td>
                    <td class="px-6 py-4">
                        <p class="font-bold text-gray-900">${ticket.subject}</p>
                        <p class="text-xs text-gray-500 capitalize">${ticket.category}</p>
                    </td>
                    <td class="px-6 py-4 text-gray-500">${dateStr}</td>
                    <td class="px-6 py-4">${getStatusBadge(ticket.status)}</td>
                </tr>
            `;
        }).join('');
    }

    if(ticketForm) {
        ticketForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btn-submit-ticket');

            const payload = {
                subject: document.getElementById('ticket-subject').value,
                category: document.getElementById('ticket-category').value,
                description: document.getElementById('ticket-description').value
            };

            btn.disabled = true;
            btn.textContent = "Submitting...";

            try {
                const res = await fetch('/.netlify/functions/support-tickets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if(res.ok) {
                    ticketForm.reset();
                    btn.textContent = "Ticket Submitted!";
                    btn.classList.replace('bg-gray-900', 'bg-emerald-600');
                    fetchTicketHistory();

                    // NEW TRIGGER: Instantly refresh the global notification badge
                    if (typeof window.updateNotificationBadge === 'function') {
                        window.updateNotificationBadge();
                    }
                } else {
                    throw new Error("Failed to submit");
                }
            } catch (err) {
                btn.textContent = "Error - Try Again";
                btn.classList.replace('bg-gray-900', 'bg-red-600');
            } finally {
                setTimeout(() => {
                    btn.disabled = false;
                    btn.textContent = "Submit Ticket";
                    btn.className = "w-full px-4 py-3 text-sm font-bold text-white bg-gray-900 hover:bg-black rounded-xl transition-colors shadow-sm";
                }, 3000);
            }
        });
    }
};