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

async function isUsernameTaken(username) {
    try {
        const response = await fetch(`/api/auth/check-username/${username}`);
        const data = await response.json();
        return !data.available;
    } catch (e) {
        return false;
    }
}

// Arriving here from the dashboard with ?reason=expired means a stored token
// was refused. Say so, rather than leaving the user to wonder why they were
// signed out.
window.addEventListener('DOMContentLoaded', () => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'expired') {
        showToast('Your session has expired. Please sign in again.', 'error', 6000);
        // Do not leave the reason in the URL for a refresh to repeat it.
        window.history.replaceState({}, '', '/auth');
    }
});

function switchTab(tab) {
    // Hide every view (some, like reset and the recovery panel, have no top tab).
    ['signin-form', 'signup-form', 'reset-form', 'recovery-panel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    document.getElementById('signin-tab').classList.remove('active');
    document.getElementById('signup-tab').classList.remove('active');

    const form = document.getElementById(`${tab}-form`);
    if (form) form.classList.add('active');
    const tabBtn = document.getElementById(`${tab}-tab`);
    if (tabBtn) tabBtn.classList.add('active');
}

/** Fill and show the one-time recovery-codes panel after sign-up. */
function showRecoveryCodes(codes) {
    const list = document.getElementById('recovery-codes-list');
    if (list) {
        list.innerHTML = '';
        (codes || []).forEach((code) => {
            const li = document.createElement('li');
            li.textContent = code;
            list.appendChild(li);
        });
    }
    ['signin-form', 'signup-form', 'reset-form'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
    const panel = document.getElementById('recovery-panel');
    if (panel) panel.classList.add('active');
}

function copyRecoveryCodes() {
    const codes = [...document.querySelectorAll('#recovery-codes-list li')].map((li) => li.textContent).join('\n');
    navigator.clipboard.writeText(codes)
        .then(() => showToast('Recovery codes copied', 'success'))
        .catch(() => showToast('Could not copy — select and copy them manually', 'error'));
}

function finishRecoverySetup() {
    window.location.href = '/dashboard';
}

async function handleResetPassword(event) {
    event.preventDefault();
    const username = document.getElementById('reset-username').value.trim();
    const recoveryCode = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-confirm').value;

    if (!username || !recoveryCode || !newPassword) {
        showToast('Please fill in all fields', 'error');
        return;
    }
    if (newPassword !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }
    if (newPassword.length < 12) {
        showToast('Password must be at least 12 characters', 'error');
        return;
    }

    try {
        const response = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, recoveryCode, newPassword }),
        });
        const data = await response.json();
        if (!response.ok) {
            showToast(data.message || 'Reset failed', 'error');
            return;
        }
        const left = typeof data.recoveryCodesRemaining === 'number'
            ? ` (${data.recoveryCodesRemaining} recovery code${data.recoveryCodesRemaining === 1 ? '' : 's'} left)`
            : '';
        showToast(`✓ Password reset${left}. Please sign in.`, 'success');
        document.getElementById('reset-username').value = '';
        document.getElementById('reset-code').value = '';
        document.getElementById('reset-password').value = '';
        document.getElementById('reset-confirm').value = '';
        switchTab('signin');
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function handleSignIn(event) {
    event.preventDefault();
    const username = document.getElementById('signin-username').value;
    const password = document.getElementById('signin-password').value;

    if (!username || !password) {
        showToast('Please fill in all fields', 'error');
        return;
    }

    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || 'Sign in failed', 'error');
            return;
        }

        showToast('✓ Sign in successful! Redirecting...', 'success');
        
        // Store auth token and user info
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('clientId', data.clientId);
        localStorage.setItem('username', data.username);
        
        setTimeout(() => {
            window.location.href = '/dashboard';
        }, 1500);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}

async function handleSignUp(event) {
    event.preventDefault();
    const username = document.getElementById('signup-username').value;
    const password = document.getElementById('signup-password').value;
    const confirm = document.getElementById('signup-confirm').value;
    const terms = document.getElementById('terms').checked;

    if (!username || !password || !confirm) {
        showToast('Please fill in all fields', 'error');
        return;
    }

    if (username.length < 3) {
        showToast('Username must be at least 3 characters', 'error');
        return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        showToast('Username can only contain letters, numbers, underscores, and hyphens', 'error');
        return;
    }

    if (await isUsernameTaken(username)) {
        showToast('Username is already taken. Please choose a different one', 'error');
        return;
    }

    if (password !== confirm) {
        showToast('Passwords do not match', 'error');
        return;
    }

    if (password.length < 12) {
        showToast('Password must be at least 12 characters', 'error');
        return;
    }

    if (!terms) {
        showToast('Please agree to the terms and conditions', 'error');
        return;
    }

    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || 'Registration failed', 'error');
            return;
        }

        showToast('✓ Account created! Save your recovery codes.', 'success');

        // Auto-log in: store auth token and user info.
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('clientId', data.clientId);
        localStorage.setItem('username', data.username);

        // Show the one-time recovery codes; the user continues to the dashboard
        // from that panel once they've saved them.
        showRecoveryCodes(data.recoveryCodes);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}
