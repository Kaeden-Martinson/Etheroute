// Check if user is already authenticated
window.addEventListener('load', () => {
    const authToken = localStorage.getItem('authToken');
    const clientId = localStorage.getItem('clientId');
    
    if (authToken && clientId) {
        // User is authenticated, show dashboard button
        document.getElementById('authButtons').style.display = 'none';
        document.getElementById('dashboardBtn').style.display = 'block';
    }
});

function toggleFaq(element) {
    const faqItem = element.parentElement;
    faqItem.classList.toggle('active');
}
