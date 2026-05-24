const API_URL = `${window.location.origin}/api`;
let totalBalanceUSD = 0;
let currentDashboardPage = 'overview';  // Track current page to prevent auto-refresh during withdrawal
window.wallets = [];  // Make wallets globally accessible for withdrawal.js

// Withdrawal module variables
let currentStep = 1;
let previewData = null;

// Toast Notification System
function showToast(message, type = 'success', duration = 4000) {
    let container = document.getElementById('toastContainer');
    
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, duration);
}

// Check authentication
window.addEventListener('load', () => {
    const token = localStorage.getItem('authToken');
    const username = localStorage.getItem('username');

    if (!token) {
        window.location.href = '/auth';
        return;
    }

    document.getElementById('username').textContent = username;
    document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();

    loadDashboardData();
    setupEventListeners();

    // Auto-refresh payouts and transactions every 10 seconds (but not on withdrawal page)
    setInterval(async () => {
        if (currentDashboardPage !== 'withdrawal') {
            await loadWallets();
            await loadPayouts();
            await loadTransactions();
        }
    }, 10000);
});

function setupEventListeners() {
    const withdrawalAmount = document.getElementById('withdrawalAmount');
    withdrawalAmount.addEventListener('input', calculateFees);

    document.getElementById('withdrawalForm').addEventListener('submit', submitWithdrawal);
    document.getElementById('createWalletForm').addEventListener('submit', createNewWallet);
}

async function loadDashboardData() {
    try {
        const response = await fetch(`${API_URL}/clients/me`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) throw new Error('Failed to load data');

        const client = await response.json();
        // Load wallets, payouts, and transactions for this client
        await loadWallets();
        await loadPayouts();
        await loadTransactions();
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

async function loadWallets() {
    try {
        const response = await fetch(`${API_URL}/wallets/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        console.log(`Wallets API response status: ${response.status}`);

        if (!response.ok) throw new Error('Failed to load wallets');

        window.wallets = await response.json();
        displayWallets();
        calculateTotalBalance();
    } catch (error) {
        console.error('Error loading wallets:', error);
    }
}

function displayWallets() {
    const container = document.getElementById('walletsContainer');

    if (window.wallets.length === 0) {
        container.innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No wallets created yet. Add one to start receiving payments.</div>';
        return;
    }

    // Group wallets by chain
    const byChain = {};
    window.wallets.forEach(w => {
        if (!byChain[w.chain]) byChain[w.chain] = [];
        byChain[w.chain].push(w);
    });

    let html = '';
    Object.entries(byChain).forEach(([chain, chainWallets]) => {
        html += `<div style="margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: #999; margin-bottom: 8px; text-transform: uppercase;">${chain}</div>
        `;

        console.log(chainWallets)

        chainWallets.forEach(w => {
            html += `<div class="wallet-item">
                <div class="wallet-info">
                    <div class="chain-badge">${chain}</div>
                    <div class="wallet-details">
                        <div class="wallet-address">${w.address.substring(0, 10)}...${w.address.substring(w.address.length - 8)}</div>
                    </div>
                </div>
                <div>
                    <div class="wallet-balance">${w.balance} ${chain}</div>
                    <div class="wallet-balance-usd">≈ $${w.balanceUSD.toFixed(2)}</div>
                </div>
                <div class="action-buttons">
                    <button class="icon-btn" onclick="copyToClipboard('${w.address}')">
                        <span data-icon="copy"></span>
                    </button>
                </div>
            </div>`;
        });

        html += '</div>';
    });

    container.innerHTML = html;
    document.getElementById('walletCount').textContent = window.wallets.length;
    loadSVGIcons();
}

function calculateTotalBalance() {
    totalBalanceUSD = 0;
    window.wallets.forEach(w => { totalBalanceUSD += w.balanceUSD; });

    document.getElementById('totalBalanceUSD').textContent = `$${totalBalanceUSD.toFixed(2)}`;
    document.getElementById('availableBalance').textContent = `$${totalBalanceUSD.toFixed(2)}`;
    
    updateWithdrawalStatus();
}

function updateWithdrawalStatus() {
    const statusEl = document.getElementById('withdrawalStatus');
    const statusText = statusEl.querySelector('.status-text');
    const statusBadge = statusEl.querySelector('.status-badge');
    const tooltip = statusEl.querySelector('.info-tooltip');
    
    if (totalBalanceUSD >= 5) {
        // Able to withdraw
        statusText.textContent = 'Able to Withdraw';
        statusBadge.className = 'status-badge available';
        statusBadge.setAttribute('data-icon', 'check');
        statusBadge.textContent = '';
        tooltip.style.display = 'none';
        statusEl.style.cursor = 'pointer';
        statusEl.onclick = () => switchDashboardPage('withdrawal');
        loadSVGIcons();
    } else {
        // Unable to withdraw
        statusText.textContent = 'Unable to Withdraw';
        statusBadge.className = 'status-badge unavailable';
        statusBadge.setAttribute('data-icon', 'alert');
        statusBadge.textContent = '';
        tooltip.style.display = 'block';
        tooltip.textContent = `Minimum $5 per wallet/chain required (Current: $${totalBalanceUSD.toFixed(2)})`;
        statusEl.style.cursor = 'default';
        statusEl.onclick = null;
        loadSVGIcons();
    }
}

async function loadPayouts() {
    try {
        const response = await fetch(`${API_URL}/payouts/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            const noPayouts = document.getElementById('noPayouts');
            const container = document.getElementById('payoutsContainer');
            if (noPayouts) noPayouts.style.display = 'block';
            if (container) container.style.display = 'none';
            return;
        }

        const payload = await response.json();
        const payouts = Array.isArray(payload) ? payload : payload.payouts || [];
        // Show all pending and processing payouts on overview
        const activePayouts = Array.isArray(payouts) ? payouts.filter(p => p.status === 'PENDING' || p.status === 'PROCESSING') : [];

        if (activePayouts && activePayouts.length > 0) {
            displayPayouts(activePayouts);
        } else {
            const noPayouts = document.getElementById('noPayouts');
            const container = document.getElementById('payoutsContainer');
            if (noPayouts) noPayouts.style.display = 'block';
            if (container) container.style.display = 'none';
        }
    } catch (error) {
        console.error('Error loading payouts:', error);
        const noPayouts = document.getElementById('noPayouts');
        const container = document.getElementById('payoutsContainer');
        if (noPayouts) noPayouts.style.display = 'block';
        if (container) container.style.display = 'none';
    }
}

function displayPayouts(payouts) {
    const container = document.getElementById('payoutsList');
    let html = '';

    payouts.forEach(payout => {
        const statusClass = `status-${payout.status.toLowerCase()}`;
        const createdDate = new Date(payout.createdAt).toLocaleString();
        const transfers = payout.withdrawalPlan?.transfers || [];

        html += `
            <div class="payout-item">
                <div class="payout-info">
                    <div class="payout-header">
                        <div class="payout-title">Payout #${payout.id.substring(0, 8)}</div>
                        <span class="status-badge ${statusClass}">${payout.status}</span>
                    </div>
                    <div class="payout-details">
                        <div><strong>Total:</strong> $${payout.totalAmountUsd.toFixed(2)}</div>
                        <div><strong>Net:</strong> $${payout.netAmountUsd.toFixed(2)}</div>
                        <div><strong>Fee:</strong> $${payout.platformFee.toFixed(2)}</div>
                        <div><strong>Created:</strong> ${createdDate}</div>
                    </div>
                    <div class="payout-chains">
                        <strong>From Chains:</strong> ${transfers.map(t => t.chain).join(', ')}
                    </div>
                    ${transfers.length > 0 ? `
                        <div class="transfer-list">
                            <strong>Transfers:</strong>
                            ${transfers.map(t => `
                                <div class="transfer-item">
                                    <span>${t.chain}: ${t.nativeAmount} → $${t.transactionValueUSD.toFixed(2)}</span>
                                    <span class="transfer-status">${t.status || 'PENDING'}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });

    document.getElementById('payoutsList').innerHTML = html;
    const containerEl = document.getElementById('payoutsContainer');
    const noPayouts = document.getElementById('noPayouts');
    if (containerEl) containerEl.style.display = 'block';
    if (noPayouts) noPayouts.style.display = 'none';
}

function displayPayoutsList(payouts) {
    const container = document.getElementById('allPayoutsList');
    let html = '';

    payouts.forEach(payout => {
        const statusClass = `status-${payout.status.toLowerCase()}`;
        const createdDate = new Date(payout.createdAt).toLocaleString();
        const transfers = payout.withdrawalPlan?.transfers || [];

        html += `
            <div class="payout-item">
                <div class="payout-info">
                    <div class="payout-header">
                        <div class="payout-title">Payout #${payout.id.substring(0, 8)}</div>
                        <span class="status-badge ${statusClass}">${payout.status}</span>
                    </div>
                    <div class="payout-details">
                        <div><strong>Total:</strong> $${payout.totalAmountUsd.toFixed(2)}</div>
                        <div><strong>Net:</strong> $${payout.netAmountUsd.toFixed(2)}</div>
                        <div><strong>Fee:</strong> $${payout.platformFee.toFixed(2)}</div>
                        <div><strong>Created:</strong> ${createdDate}</div>
                    </div>
                    <div class="payout-chains">
                        <strong>From Chains:</strong> ${transfers.map(t => t.chain).join(', ')}
                    </div>
                    ${transfers.length > 0 ? `
                        <div class="transfer-list">
                            <strong>Transfers:</strong>
                            ${transfers.map(t => `
                                <div class="transfer-item">
                                    <span>${t.chain}: ${t.nativeAmount} → $${t.transactionValueUSD.toFixed(2)}</span>
                                    <span class="transfer-status">${t.status || 'PENDING'}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function displayTransactionsList(transactions) {
    const container = document.getElementById('allTransactionsList');
    let html = '';

    transactions.forEach(tx => {
        const statusClass = `status-${tx.status.toLowerCase()}`;
        const createdDate = new Date(tx.createdAt).toLocaleString();
        const hash = tx.transactionHash ? tx.transactionHash : 'Pending';
        const broadcastedAt = tx.broadcastedAt ? new Date(tx.broadcastedAt).toLocaleString() : '-';

        let statusDetails = '';
        if (tx.status === 'PROCESSING') {
            statusDetails = `Broadcasted: ${broadcastedAt}`;
        } else if (tx.status === 'CONFIRMED' || tx.status === 'COMPLETED') {
            statusDetails = `Block: ${tx.blockNumber || 'N/A'}`;
        } else if (tx.status === 'FAILED') {
            statusDetails = `Reason: ${tx.failureReason || 'Unknown'} - ${tx.failureMessage || ''}`;
        }

        html += `
            <div class="transaction-item">
                <div class="transaction-info">
                    <div class="transaction-header">
                        <span>${tx.chain} - ${tx.type}</span>
                        <span class="status-badge ${statusClass}">${tx.status}</span>
                    </div>
                    <div class="transaction-details">
                        <div><strong>Amount:</strong><br>${tx.nativeAmount} ${tx.chain} ($${tx.usdAmount?.toFixed(2) || '0.00'})</div>
                        <div><strong>TX Hash:</strong><br>${hash}</div>
                        <div><strong>Created:</strong><br>${createdDate}</div>
                        <div><strong>Completion Date:</strong><br>${tx.completedAt ? new Date(tx.completedAt).toLocaleString() : '-'}</div>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

async function loadTransactions() {
    try {
        const response = await fetch(`${API_URL}/transactions/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            return;
        }

        let transactions = await response.json();
        
        // Filter pending, processing, confirmed, completed, and failed transactions
        if (Array.isArray(transactions)) {
            transactions = transactions.filter(t => 
                t.status === 'PENDING' || t.status === 'PROCESSING' || t.status === 'CONFIRMED' || t.status === 'COMPLETED' || t.status === 'FAILED'
            ).slice(0, 10); // Show last 10 relevant transactions
        }

        if (transactions && transactions.length > 0) {
            displayTransactions(transactions);
        }
    } catch (error) {
        console.error('Error loading transactions:', error);
    }
}

function displayTransactions(transactions) {
    const container = document.getElementById('transactionsList');
    let html = '';

    transactions.forEach(tx => {
        const statusClass = `status-${tx.status.toLowerCase()}`;
        const createdDate = new Date(tx.createdAt).toLocaleString();
        const hash = tx.transactionHash ? tx.transactionHash.substring(0, 10) + '...' : 'Pending';
        const broadcastedAt = tx.broadcastedAt ? new Date(tx.broadcastedAt).toLocaleString() : '-';

        let statusDetails = '';
        if (tx.status === 'PROCESSING') {
            statusDetails = `Broadcasted: ${broadcastedAt}`;
        } else if (tx.status === 'CONFIRMED') {
            statusDetails = `Block: ${tx.blockNumber || 'N/A'}`;
        } else if (tx.status === 'FAILED') {
            statusDetails = `Reason: ${tx.failureReason || 'Unknown'} - ${tx.failureMessage || ''}`;
        }

        html += `
            <div class="transaction-item">
                <div class="transaction-info">
                    <div class="transaction-header">
                        <span>${tx.chain} - ${tx.type}</span>
                        <span class="status-badge ${statusClass}">${tx.status}</span>
                    </div>
                    <div class="transaction-details">
                        <div><strong>Amount:</strong> ${tx.nativeAmount} ${tx.chain} ($${tx.usdAmount.toFixed(2)})</div>
                        <div><strong>Hash:</strong> ${hash}</div>
                        <div><strong>Created:</strong> ${createdDate}</div>
                        <div><strong>${statusDetails ? statusDetails : 'Status: Awaiting confirmation'}</strong></div>
                    </div>
                </div>
            </div>
        `;
    });

    if (container) {
        container.innerHTML = html;
        loadSVGIcons();
    }
}

function calculateFees() {
    const amount = parseFloat(document.getElementById('withdrawalAmount').value) || 0;
    const fee = amount * 0.05;
    const receive = amount - fee;

    document.getElementById('feeAmount').textContent = `$${amount.toFixed(2)}`;
    document.getElementById('feeTotal').textContent = `$${fee.toFixed(2)}`;
    document.getElementById('youWillReceive').textContent = `$${receive.toFixed(2)}`;
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!', 'success', 2000);
}

function openWithdrawalModal() {
    if (totalBalanceUSD < 5) {
        showToast('Minimum $5 per wallet/chain required', 'error');
        return;
    }
    document.getElementById('withdrawalModal').classList.add('show');
}

function closeWithdrawalModal() {
    document.getElementById('withdrawalModal').classList.remove('show');
}

function openCreateWalletModal() {
    document.getElementById('createWalletModal').classList.add('show');
}

function closeCreateWalletModal() {
    document.getElementById('createWalletModal').classList.remove('show');
}

function openAPIModal() {
    document.getElementById('apiModal').classList.add('show');
    loadAPIKeys();
}

function closeAPIModal() {
    document.getElementById('apiModal').classList.remove('show');
}

function closeAPIModalOnClickOutside(event) {
    const modal = document.getElementById('apiModal');
    const modalContent = document.querySelector('#apiModal .modal-content');
    
    // Only close if clicking on the modal background (not the content)
    if (event.target === modal) {
        closeAPIModal();
    }
}

async function submitWithdrawal(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const errorDiv = document.getElementById('withdrawalError');
    errorDiv.classList.remove('show');

    const amount = parseFloat(document.getElementById('withdrawalAmount').value);
    if (amount < 5) {
        errorDiv.textContent = 'Minimum withdrawal is $5 per wallet/chain';
        errorDiv.classList.add('show');
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Processing...';

    try {
        const response = await fetch(`${API_URL}/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId'),
                recipientAddress: document.getElementById('withdrawalAddress').value,
                selectedChains: ['ETH']
            })
        });

        const data = await response.json();
        if (response.ok) {
            showToast(`Withdrawal Initiated! Amount: $${data.withdrawalAmount.toFixed(2)}, Fee: $${data.platformFee.toFixed(2)}`, 'success');
            closeWithdrawalModal();
            document.getElementById('withdrawalForm').reset();
            loadWallets(); // Refresh to update balances
        } else {
            errorDiv.textContent = data.message || 'Withdrawal failed';
            errorDiv.classList.add('show');
        }
    } catch (error) {
        errorDiv.textContent = 'An error occurred: ' + error.message;
        errorDiv.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Confirm Withdrawal';
    }
}

async function createNewWallet(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const chain = document.getElementById('walletChain').value;

    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
        const response = await fetch(`${API_URL}/wallets/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId'),
                chain: chain
            })
        });

        if (response.ok) {
            closeCreateWalletModal();
            await loadWallets();
            loadWalletsList();
            showToast('Wallet created successfully', 'success');
        } else {
            showToast('Failed to create wallet', 'error');
        }
    } catch (error) {
        showToast('Error creating wallet', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Create Wallet';
    }
}

async function loadAPIKeys() {
    const container = document.getElementById('apiKeysContainer');
    try {
        const response = await fetch(`${API_URL}/api-keys`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        const data = await response.json();
        
        if (!data.hasKey || !data.apiKey) {
            container.innerHTML = `
                <div style="background: #f8f8f8; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                    <div style="font-size: 12px; color: #999; margin-bottom: 6px;">Active API Key</div>
                    <div style="font-family: 'Courier New', monospace; font-size: 11px; color: #999;">None</div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div style="background: #f8f8f8; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                    <div style="font-size: 12px; color: #999; margin-bottom: 6px;">Active API Key</div>
                    <div style="font-family: 'Courier New', monospace; font-size: 11px; word-break: break-all; color: #1a1a1a;">${data.apiKey}</div>
                    <button class="bigger-icon-btn btn-small" style="margin-top: 8px;" onclick="copyToClipboard('${data.apiKey}')">
                        <span data-icon="copy"></span>
                        Copy
                    </button>
                </div>
            `;
            loadSVGIcons();
        }
    } catch (error) {
        container.innerHTML = '<p style="color: #999;">Error loading API keys</p>';
    }
}

function generateNewAPIKey() {
    document.getElementById('apiConfirmationOverlay').classList.add('show');
}

async function confirmGenerateAPIKey() {
    document.getElementById('apiConfirmationOverlay').classList.remove('show');

    try {
        const response = await fetch(`${API_URL}/api-keys/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId')
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            loadAPIKeys();
            showToast('API key generated successfully!', 'success');
        } else {
            showToast('Failed to generate new API key', 'error');
        }
    } catch (error) {
        showToast('Error generating API key', 'error');
    }
}

function denyGenerateAPIKey() {
    document.getElementById('apiConfirmationOverlay').classList.remove('show');
}

function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('clientId');
    localStorage.removeItem('username');
    window.location.href = '/auth';
}

function toggleUserMenu() {
    // Implement user menu if needed
}

// Dashboard Navigation
let currentChartPeriod = 'day';

function switchDashboardPage(page) {
    currentDashboardPage = page;  // Update the current page tracker
    
    // Hide all pages
    document.querySelectorAll('.dashboard-page').forEach(el => {
        el.style.display = 'none';
    });

    // Show selected page
    const pageEl = document.getElementById(page + 'Page');
    if (pageEl) {
        pageEl.style.display = 'block';
    }

    // Update active nav item
    document.querySelectorAll('.nav-link').forEach((el, index) => {
        el.classList.remove('active');
        const pages = ['overview', 'transactions', 'wallets', 'payouts', 'withdrawal'];
        if (pages[index] === page) {
            el.classList.add('active');
            if (page === 'overview') {
                loadDashboardData();
            } else if (page === 'transactions') {
                loadTransactionsList();
            } else if (page === 'wallets') {
                loadWalletsList();
            } else if (page === 'payouts') {
                loadPayoutsList();
            }
        }
    });
}

function switchChartPeriod(period) {
    currentChartPeriod = period;
    // Update all period buttons
    document.getElementById('hourBtn').classList.remove('btn-primary');
    document.getElementById('hourBtn').classList.add('btn-secondary');
    document.getElementById('dayBtn').classList.remove('btn-primary');
    document.getElementById('dayBtn').classList.add('btn-secondary');
    document.getElementById('weekBtn').classList.remove('btn-primary');
    document.getElementById('weekBtn').classList.add('btn-secondary');
    
    // Set active button to black/primary
    const btnId = period + 'Btn';
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
    }
    
    loadAPICallsChart();
}

async function loadAPICallsChart() {
    try {
        const token = localStorage.getItem('authToken');

        // Fetch API calls data
        const response = await fetch(`/api/api-calls/stats?period=${currentChartPeriod}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) throw new Error('Failed to fetch API calls');

        const data = await response.json();
        const ctx = document.getElementById('apiCallsChart').getContext('2d');
        
        // Destroy existing chart if it exists
        if (window.apiCallsChartInstance) {
            window.apiCallsChartInstance.destroy();
        }

        // Create new chart
        window.apiCallsChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.labels || [],
                datasets: [{
                    label: `API Calls (${currentChartPeriod})`,
                    data: data.values || [],
                    borderColor: '#1a1a1a',
                    backgroundColor: 'rgba(26, 26, 26, 0.05)',
                    tension: 0.4,
                    fill: true,
                    pointRadius: 4,
                    pointBackgroundColor: '#1a1a1a',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#f0f0f0' }
                    },
                    x: {
                        grid: { color: '#f0f0f0' }
                    }
                }
            }
        });
    } catch (error) {
        console.error('Error loading API calls chart:', error);
    }
}

async function loadTransactionsList() {
    try {
        const response = await fetch(`${API_URL}/transactions/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            document.getElementById('allTransactionsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No transactions found.</div>';
            return;
        }

        let transactions = await response.json();
        
        // Show all pending, processing, and completed transactions
        if (Array.isArray(transactions)) {
            transactions = transactions.filter(t => 
                t.status === 'PENDING' || t.status === 'PROCESSING' || t.status === 'CONFIRMED' || t.status === 'COMPLETED' || t.status === 'FAILED'
            );
        }

        if (transactions && transactions.length > 0) {
            displayTransactionsList(transactions);
        } else {
            document.getElementById('allTransactionsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No transactions found.</div>';
        }
    } catch (error) {
        console.error('Error loading transactions list:', error);
        document.getElementById('allTransactionsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">Error loading transactions.</div>';
    }
}

function loadWalletsList() {
    // Display all wallets for the wallets page, grouped by chain
    if (!window.wallets || window.wallets.length === 0) {
        document.getElementById('allWalletsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No wallets created yet. Click "Add Wallet" to create one.</div>';
        return;
    }

    // Group wallets by chain
    const byChain = {};
    window.wallets.forEach(w => {
        if (!byChain[w.chain]) byChain[w.chain] = [];
        byChain[w.chain].push(w);
    });

    let html = '';
    Object.entries(byChain).forEach(([chain, chainWallets]) => {
        html += `<div style="margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: #999; margin-bottom: 8px; text-transform: uppercase;">${chain}</div>
        `;

        chainWallets.forEach(w => {
            html += `<div class="wallet-item">
                <div class="wallet-info">
                    <div class="chain-badge">${chain}</div>
                    <div class="wallet-details">
                        <div class="wallet-address">${w.address.substring(0, 10)}...${w.address.substring(w.address.length - 8)}</div>
                    </div>
                </div>
                <div>
                    <div class="wallet-balance">${w.balance} ${chain}</div>
                    <div class="wallet-balance-usd">≈ $${w.balanceUSD.toFixed(2)}</div>
                </div>
                <div class="action-buttons">
                    <button class="icon-btn" onclick="copyToClipboard('${w.address}')" title="Copy address">
                        <span data-icon="copy"></span>
                    </button>
                    <button class="icon-btn delete-btn" onclick="deleteWallet('${w.id}', '${chain}')" title="Delete wallet">
                        <span data-icon="delete"></span>
                    </button>
                </div>
            </div>`;
        });

        html += '</div>';
    });

    document.getElementById('allWalletsList').innerHTML = html;
}

async function deleteWallet(walletId, chain) {
    // Store the wallet info for the confirmation handler
    window.pendingDeleteWallet = { walletId, chain };
    
    // Show the confirmation overlay
    const overlay = document.getElementById('deleteConfirmationOverlay');
    const text = document.getElementById('deleteConfirmationText');
    text.textContent = `Are you sure you want to delete this ${chain} wallet? This action cannot be undone.`;
    
    if (overlay) {
        overlay.classList.add('show');
    }
}

async function confirmDeleteWallet() {
    const pending = window.pendingDeleteWallet;
    if (!pending) return;

    const { walletId, chain } = pending;
    const overlay = document.getElementById('deleteConfirmationOverlay');

    try {
        const response = await fetch(`${API_URL}/wallets/delete`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId'),
                walletId
            })
        });

        if (!response.ok) {
            const data = await response.json();
            showToast(data.message || 'Failed to delete wallet', 'error');
            return;
        }

        showToast(`${chain} wallet deleted successfully`, 'success');
        // Reload wallets from API
        await loadWallets();
        // Refresh wallets page display
        loadWalletsList();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        // Hide the confirmation overlay
        if (overlay) {
            overlay.classList.remove('show');
        }
        window.pendingDeleteWallet = null;
    }
}

function denyDeleteWallet() {
    const overlay = document.getElementById('deleteConfirmationOverlay');
    if (overlay) {
        overlay.classList.remove('show');
    }
    window.pendingDeleteWallet = null;
}

async function loadPayoutsList() {
    try {
        const response = await fetch(`${API_URL}/payouts/list`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });

        if (!response.ok) {
            document.getElementById('allPayoutsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No payouts found.</div>';
            return;
        }

        const payload = await response.json();
        const payouts = Array.isArray(payload) ? payload : payload.payouts || [];
        
        // Show all pending, processing, and completed payouts
        const allPayouts = Array.isArray(payouts) ? payouts.filter(p => 
            p.status === 'PENDING' || p.status === 'PROCESSING' || p.status === 'COMPLETED' || p.status === 'FAILED'
        ) : [];

        if (allPayouts && allPayouts.length > 0) {
            displayPayoutsList(allPayouts);
        } else {
            document.getElementById('allPayoutsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">No payouts found.</div>';
        }
    } catch (error) {
        console.error('Error loading payouts list:', error);
        document.getElementById('allPayoutsList').innerHTML = '<div style="padding: 24px; text-align: center; color: #999;">Error loading payouts.</div>';
    }
}

// Initialize API calls chart on page load
window.addEventListener('DOMContentLoaded', () => {
    // Set initial button state - Day is active (black), others are normal
    document.getElementById('hourBtn').classList.add('btn-secondary');
    document.getElementById('hourBtn').classList.remove('btn-primary');
    document.getElementById('dayBtn').classList.add('btn-primary');
    document.getElementById('dayBtn').classList.remove('btn-secondary');
    document.getElementById('weekBtn').classList.add('btn-secondary');
    document.getElementById('weekBtn').classList.remove('btn-primary');
    loadAPICallsChart();
});

// ========== WITHDRAWAL SECTION (from withdrawal.js) ==========

function goToStep(step) {
    if (step > 4 || step < 1) return;
    if (step === 4 && previewData) { displayFinalSummary(); }
    document.querySelectorAll('.section-step').forEach(el => el.classList.remove('active'));
    document.getElementById(`step${step}`).classList.add('active');
    document.querySelectorAll('.step-badge').forEach((el, idx) => {
        el.classList.remove('active', 'completed');
        if (idx + 1 < step) el.classList.add('completed');
        if (idx + 1 === step) el.classList.add('active');
    });
    currentStep = step;
    window.scrollTo(0, 0);
}

function goBackToStep(step) {
    if (step >= currentStep) return;
    goToStep(step);
}

async function loadWithdrawalWallets() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const msg = document.getElementById('step1-message');

    if (!recipientAddress) {
        msg.innerHTML = '<div class="alert alert-error">Please enter Recipient ETH Address</div>';
        return;
    }
    if (!recipientAddress.startsWith('0x') || recipientAddress.length !== 42) {
        msg.innerHTML = '<div class="alert alert-error">Invalid ETH address (should be 0x...)</div>';
        return;
    }

    msg.innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Loading wallets...</div>';

    try {
        // If wallets are already loaded (from dashboard context), use them
        if (window.wallets && Array.isArray(window.wallets) && window.wallets.length > 0) {
            displayWalletSelection(window.wallets);
            goToStep(2);
            return;
        }

        // Otherwise, fetch from API (for standalone page)
        const response = await fetch(`${API_URL}/wallets/list`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        window.wallets = await response.json();
        if (!response.ok || !Array.isArray(window.wallets) || window.wallets.length === 0) {
            msg.innerHTML = '<div class="alert alert-error">No wallets found</div>';
            return;
        }
        displayWalletSelection(window.wallets);
        goToStep(2);
    } catch (error) {
        msg.innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
    }
}

function displayWalletSelection(wallets) {
    const container = document.getElementById('wallets-container');
    let eligible = 0;
    let html = '';
    wallets.forEach(wallet => {
        const balanceUSD = wallet.balanceUSD || 0;
        const isEligible = balanceUSD >= 5;
        if (isEligible) eligible++;
        const status = isEligible ? '✓ Ready' : '✗ Below $5 USD';
        const classes = isEligible ? '' : 'disabled';
        html += `<div class="wallet-card ${classes}"><div class="wallet-info"><div class="wallet-chain">${wallet.chain}</div><div class="wallet-balance">${wallet.balance} ${wallet.chain} = $${balanceUSD.toFixed(2)} USD - ${status}</div></div><input type="checkbox" name="withdrawChain" value="${wallet.chain}" class="wallet-checkbox" ${isEligible ? '' : 'disabled'} /></div>`;
    });
    container.innerHTML = html;
    document.getElementById('step2-message').innerHTML = `<div class="alert alert-success">✓ Found ${eligible} wallet(s) ready</div>`;
}

async function getPreview() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const selectedChains = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    if (selectedChains.length === 0) {
        document.getElementById('step2-message').innerHTML = '<div class="alert alert-error">Please select at least one chain</div>';
        return;
    }
    document.getElementById('step2-message').innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Loading preview...</div>';
    try {
        const response = await fetch(`${API_URL}/withdrawal/preview?recipientAddress=${encodeURIComponent(recipientAddress)}&selectedChains=${selectedChains.join(',')}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        const result = await response.json();
        if (!response.ok) {
            document.getElementById('step2-message').innerHTML = `<div class="alert alert-error">Error: ${result.message || 'Unknown'}</div>`;
            return;
        }
        previewData = result.data;
        console.log('Preview data:', previewData);
        displayPreview();
        goToStep(3);
    } catch (error) {
        console.error('Preview error:', error);
        document.getElementById('step2-message').innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
    }
}

function displayPreview() {
    let html = '<div class="summary-box"><div class="summary-title">Withdrawal Summary</div>';
    const data = previewData;
    
    // Get the selected chains and calculate per-chain breakdown
    const selectedChains = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    
    if (selectedChains.length > 0 && window.wallets) {
        let chainHtml = '';
        let totalUsd = 0;
        let totalPlatformFee = 0;
        let totalNetUsd = 0;
        
        // First pass: calculate totals
        selectedChains.forEach(chainName => {
            const wallet = window.wallets.find(w => w.chain === chainName);
            if (wallet) {
                const chainUsd = (wallet.balanceUSD || 0);
                const platformFee = chainUsd * 0.05;
                const gasUsd = data.gasPerChain && data.gasPerChain[chainName] ? data.gasPerChain[chainName] : 0.15;
                
                totalUsd += chainUsd;
                totalPlatformFee += platformFee;
            }
        });
        
        totalNetUsd = totalUsd - totalPlatformFee - data.totalGasUsd;
        
        // Second pass: render per-chain items
        selectedChains.forEach(chainName => {
            const wallet = window.wallets.find(w => w.chain === chainName);
            if (wallet) {
                const chainUsd = (wallet.balanceUSD || 0);
                const chainPlatformFee = chainUsd * 0.05;
                const chainGasUsd = data.gasPerChain && data.gasPerChain[chainName] ? data.gasPerChain[chainName] : 0.15;
                const chainNetUsd = chainUsd - chainPlatformFee - chainGasUsd;
                
                chainHtml += `<div class="preview-item" style="margin-bottom: 16px; padding: 12px; background: #f9f9f9; border-radius: 6px;">
                    <div class="summary-row" style="font-weight: 600; margin-bottom: 8px;"><span>${wallet.chain}</span><span></span></div>
                    <div class="summary-row"><span>Amount:</span><span>$${chainUsd.toFixed(2)} USD</span></div>
                    <div class="summary-row"><span>Platform Fee (5%):</span><span>-$${chainPlatformFee.toFixed(2)}</span></div>
                    <div class="summary-row"><span>Gas Fee:</span><span>-$${chainGasUsd.toFixed(2)}</span></div>
                    <div class="summary-row" style="font-weight: 600; color: #27ae60;"><span>Net Amount:</span><span>$${chainNetUsd.toFixed(2)}</span></div>
                </div>`;
            }
        });
        
        html += chainHtml;
        
        // Add total summary with per-chain breakdown
        html += `<div style="border-top: 2px solid #e5e5e5; margin-top: 12px; padding-top: 12px;">
            <div class="summary-title" style="font-size: 14px; margin-bottom: 8px;">Total Summary</div>`;
        
        html += `<div class="summary-row" style="font-weight: 600; border-top: 1px solid #e5e5e5; padding-top: 8px; margin-top: 8px;"><span>Total Amount:</span><span>$${totalUsd.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Platform Fee:</span><span>-$${totalPlatformFee.toFixed(2)}</span></div>
            <div class="summary-row"><span>Total Gas Fee:</span><span>-$${data.totalGasUsd.toFixed(2)}</span></div>
            <div class="summary-row" style="font-weight: 600; color: #27ae60;"><span>Total Net Amount:</span><span>$${totalNetUsd.toFixed(2)}</span></div>
        </div>`;
    }
    
    html += '</div>';
    document.getElementById('preview-details').innerHTML = html;
}

function displayFinalSummary() {
    if (!previewData) return;
    const recipientAddr = (previewData.recipientAddress || 'N/A');
    
    let html = '<div class="summary-box"><div class="summary-title">Final Summary</div>';
    
    // Get the selected chains and calculate per-chain breakdown
    const selectedChains = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    
    if (selectedChains.length > 0 && window.wallets) {
        let totalUsd = 0;
        let totalPlatformFee = 0;
        let totalNetUsd = 0;
        
        // First pass: calculate totals
        selectedChains.forEach(chainName => {
            const wallet = window.wallets.find(w => w.chain === chainName);
            if (wallet) {
                const chainUsd = (wallet.balanceUSD || 0);
                const platformFee = chainUsd * 0.05;
                const gasUsd = 0.15;
                
                totalUsd += chainUsd;
                totalPlatformFee += platformFee;
            }
        });
        
        totalNetUsd = totalUsd - totalPlatformFee - previewData.totalGasUsd;
        
        html += `<div class="summary-row" style="font-weight: 600; border-top: 1px solid #e5e5e5; padding-top: 8px; margin-top: 8px;"><span>Total Amount:</span><span>$${totalUsd.toFixed(2)}</span></div>`;
        html += `<div class="summary-row"><span>Total Platform Fee:</span><span>-$${totalPlatformFee.toFixed(2)}</span></div>`;
        html += `<div class="summary-row"><span>Total Gas Fee:</span><span>-$${previewData.totalGasUsd.toFixed(2)}</span></div>`;
        html += `<div class="summary-row" style="font-weight: 600; color: #27ae60;"><span>Total Net Amount:</span><span>$${totalNetUsd.toFixed(2)}</span></div>`;
    }
    
    html += `<div class="summary-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e5e5;"><span>To Address:</span><span style="font-size: 11px; word-break: break-all;">${recipientAddr}</span></div></div>`;
    
    document.getElementById('final-summary').innerHTML = html;
}

async function processWithdrawal() {
    const recipientAddress = document.getElementById('recipientAddress').value.trim();
    const selectedChains = Array.from(document.querySelectorAll('input[name="withdrawChain"]:checked')).map(cb => cb.value);
    const confirmBtn = document.getElementById('confirmBtn');
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="loading-spinner"></span>Processing...';
    document.getElementById('step4-message').innerHTML = '<div class="alert alert-info"><span class="loading-spinner"></span>Initiating withdrawal...</div>';

    try {
        const response = await fetch(`${API_URL}/withdrawal`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`
            },
            body: JSON.stringify({
                clientId: localStorage.getItem('clientId'),
                recipientAddress,
                selectedChains
            })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'Failed');

        showToast('Withdrawal submitted successfully!', 'success');
        // Reset to step 1 for new withdrawal
        clearStep1();
        goToStep(1);
    } catch (error) {
        document.getElementById('step4-message').innerHTML = `<div class="alert alert-error">Error: ${error.message}</div>`;
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'Confirm Withdrawal';
    }
}

function clearStep1() { document.getElementById('recipientAddress').value = ''; }

function logout() {
    localStorage.removeItem('authToken');
    localStorage.removeItem('clientId');
    localStorage.removeItem('username');
    window.location.href = '/auth';
}
