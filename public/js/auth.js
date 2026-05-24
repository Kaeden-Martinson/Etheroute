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

function switchTab(tab) {
    // Hide all forms
    document.getElementById('signin-form').classList.remove('active');
    document.getElementById('signup-form').classList.remove('active');
    
    // Remove active class from tabs
    document.getElementById('signin-tab').classList.remove('active');
    document.getElementById('signup-tab').classList.remove('active');
    
    // Show selected form
    document.getElementById(`${tab}-form`).classList.add('active');
    document.getElementById(`${tab}-tab`).classList.add('active');
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

    if (password.length < 8) {
        showToast('Password must be at least 8 characters', 'error');
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

        showToast('✓ Account created! Redirecting...', 'success');
        
        // Auto-log in: Store auth token and user info
        localStorage.setItem('authToken', data.token);
        localStorage.setItem('clientId', data.clientId);
        localStorage.setItem('username', data.username);
        
        // Redirect to dashboard
        setTimeout(() => {
            window.location.href = '/dashboard';
        }, 1500);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
    }
}
