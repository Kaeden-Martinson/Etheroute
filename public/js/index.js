// Check if user is already authenticated
window.addEventListener('load', () => {
    const authToken = localStorage.getItem('authToken');
    const clientId = localStorage.getItem('clientId');
    
    if (authToken && clientId) {
        // User is authenticated, show dashboard button
        document.getElementById('authButtons').style.display = 'none';
        document.getElementById('dashboardBtn').style.display = 'block';
        
        // Hide Get Started button and show Dashboard button in hero
        document.getElementById('heroGetStartedBtn').style.display = 'none';
        document.getElementById('heroDashboardBtn').style.display = 'block';
    }
    
    // Handle Hero Get Started button
    const heroGetStartedBtn = document.getElementById('heroGetStartedBtn');
    if (heroGetStartedBtn) {
        heroGetStartedBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const authToken = localStorage.getItem('authToken');
            const clientId = localStorage.getItem('clientId');
            
            if (authToken && clientId) {
                // User is logged in, redirect to dashboard
                window.location.href = '/dashboard';
            } else {
                // User is not logged in, redirect to auth
                window.location.href = '/auth';
            }
        });
    }
    
    // Handle CTA Start Withdrawing button
    const ctaStartBtn = document.getElementById('ctaStartBtn');
    if (ctaStartBtn) {
        ctaStartBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const authToken = localStorage.getItem('authToken');
            const clientId = localStorage.getItem('clientId');
            
            if (authToken && clientId) {
                // User is logged in, redirect to dashboard
                window.location.href = '/dashboard';
            } else {
                // User is not logged in, redirect to auth
                window.location.href = '/auth';
            }
        });
    }
});
