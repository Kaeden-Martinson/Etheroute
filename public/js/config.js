// API Configuration
// Use same-origin API base so frontend works on localhost, custom hosts, and deployed domains.
const API_URL = `${window.location.origin}/api`;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { API_URL };
}
