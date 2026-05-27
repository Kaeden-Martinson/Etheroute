const endpointCodeTemplates = {};
const languageLabels = {
    curl: 'cURL',
    nodejs: 'Node.js',
    python: 'Python',
    cpp: 'C++',
    csharp: 'C#'
};
const languageSyntaxClasses = {
    curl: 'language-bash',
    nodejs: 'language-javascript',
    python: 'language-python',
    cpp: 'language-cpp',
    csharp: 'language-csharp'
};

// Toast Notification System
function showToast(message, type = 'success', duration = 2500) {
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

// Load SVG icons and highlight code on page load
window.addEventListener('load', () => {
    loadSVGIcons();
    
    // Update all code examples with the actual API URL
    updateCodeExamplesWithAPIURL();

    // Keep one code block per endpoint and swap content by language.
    consolidateLanguageCodeBlocks();
    
    // Add copy buttons to all code blocks
    addCopyButtonsToCodeBlocks();

    // Keep all endpoint cards expanded at all times.
    forceExpandedEndpoints();
    
    // Setup dynamic code updates for input changes
    setupDynamicCodeUpdates();
    
    // Highlight all code blocks with highlight.js
    document.querySelectorAll('pre code').forEach(el => {
        hljs.highlightElement(el);
    });
});

function forceExpandedEndpoints() {
    document.querySelectorAll('.endpoint-item').forEach((item) => {
        item.classList.add('active');
    });
}

function consolidateLanguageCodeBlocks() {
    document.querySelectorAll('.language-select').forEach((select) => {
        const endpoint = select.getAttribute('data-endpoint');
        if (!endpoint) return;

        moveLanguageSelectorToHeader(select, endpoint);

        ensureLanguageOption(select, 'cpp', languageLabels.cpp);
        ensureLanguageOption(select, 'csharp', languageLabels.csharp);

        const languageBlocks = ['curl', 'nodejs', 'python']
            .map((lang) => ({ lang, block: document.getElementById(`${endpoint}-${lang}`) }))
            .filter(({ block }) => !!block);

        if (!languageBlocks.length) return;

        endpointCodeTemplates[endpoint] = {};
        languageBlocks.forEach(({ lang, block }) => {
            const code = block.querySelector('code');
            endpointCodeTemplates[endpoint][lang] = {
                content: code ? code.textContent : '',
                className: code ? code.className : ''
            };
        });

        ensureExtendedLanguageTemplates(endpoint);

        const preferredLanguage = endpointCodeTemplates[endpoint][select.value]
            ? select.value
            : languageBlocks[0].lang;

        const placeholder = document.getElementById(`${endpoint}-${preferredLanguage}`) || languageBlocks[0].block;
        placeholder.id = `${endpoint}-code`;
        placeholder.setAttribute('data-endpoint', endpoint);
        placeholder.style.display = 'block';

        languageBlocks.forEach(({ block }) => {
            if (block !== placeholder) {
                block.remove();
            }
        });

        select.value = preferredLanguage;
        applyLanguageToPlaceholder(endpoint, preferredLanguage);
    });
}

function ensureLanguageOption(select, value, label) {
    if (select.querySelector(`option[value="${value}"]`)) return;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
}

function moveLanguageSelectorToHeader(select, endpoint) {
    const endpointItem = select.closest('.endpoint-item');
    if (!endpointItem) return;

    let slot = endpointItem.querySelector('.endpoint-language-slot');
    if (!slot) {
        slot = document.createElement('div');
        slot.className = 'endpoint-language-slot';
        const header = endpointItem.querySelector('.endpoint-header');
        if (!header) return;
        header.appendChild(slot);
    }

    const selectorContainer = select.closest('.language-selector');
    if (!selectorContainer) return;

    selectorContainer.classList.add('language-selector-inline');
    selectorContainer.setAttribute('data-endpoint', endpoint);
    slot.appendChild(selectorContainer);
}

function ensureExtendedLanguageTemplates(endpoint) {
    const templates = endpointCodeTemplates[endpoint];
    if (!templates) return;

    const requestInfo = extractRequestInfo(templates);

    if (!templates.cpp) {
        templates.cpp = {
            content: buildCppTemplate(requestInfo),
            className: 'language-cpp'
        };
    }

    if (!templates.csharp) {
        templates.csharp = {
            content: buildCSharpTemplate(requestInfo),
            className: 'language-csharp'
        };
    }
}

function extractRequestInfo(templates) {
    const curl = templates.curl ? templates.curl.content : '';
    const nodejs = templates.nodejs ? templates.nodejs.content : '';

    let method = 'GET';
    let url = `${API_URL}/`;
    let body = '';

    const curlMatch = curl.match(/curl\s+-X\s+([A-Z]+)\s+([^\s\\]+)/);
    if (curlMatch) {
        method = curlMatch[1];
        url = curlMatch[2];
    }

    const nodeMethodMatch = nodejs.match(/method:\s*'([A-Z]+)'/);
    if (nodeMethodMatch) {
        method = nodeMethodMatch[1];
    }

    const nodeUrlMatch = nodejs.match(/fetch\('([^']+)'/);
    if (nodeUrlMatch) {
        url = nodeUrlMatch[1];
    }

    const curlBodyMatch = curl.match(/-d\s+'([\s\S]*?)'/);
    if (curlBodyMatch) {
        body = curlBodyMatch[1].trim();
    }

    const nodeBodyMatch = nodejs.match(/body:\s*JSON\.stringify\((\{[\s\S]*?\})\)/);
    if (!body && nodeBodyMatch) {
        body = nodeBodyMatch[1].trim();
    }

    return { method, url, body };
}

function buildCppTemplate({ method, url, body }) {
    const hasBody = !!body && method !== 'GET';
    const requestMethod = method === 'DELETE' ? 'Delete' : method === 'PUT' ? 'Put' : method === 'POST' ? 'Post' : 'Get';
    const bodyLine = hasBody
        ? `,\n        cpr::Body{R"(${body})"}`
        : '';
    const contentTypeHeader = hasBody
        ? `,\n        {"Content-Type", "application/json"}`
        : '';

    return `#include <iostream>\n#include <cpr/cpr.h>\n\nint main() {\n    auto response = cpr::${requestMethod}(\n        cpr::Url{"${url}"},\n        cpr::Header{\n            {"Authorization", "Bearer YOUR_API_KEY"}${contentTypeHeader}\n        }${bodyLine}\n    );\n\n    std::cout << response.text << std::endl;\n    return 0;\n}`;
}

function buildCSharpTemplate({ method, url, body }) {
    const hasBody = !!body && method !== 'GET';
    const httpMethod = method === 'DELETE' ? 'Delete' : method === 'PUT' ? 'Put' : method === 'POST' ? 'Post' : 'Get';
    const bodyEscaped = body.replace(/"/g, '\\"');
    const contentSetup = hasBody
        ? `\nrequest.Content = new StringContent("${bodyEscaped}", Encoding.UTF8, "application/json");`
        : '';

    return `using System;\nusing System.Net.Http;\nusing System.Net.Http.Headers;\nusing System.Text;\nusing System.Threading.Tasks;\n\nclass Program\n{\n    static async Task Main()\n    {\n        using var client = new HttpClient();\n        using var request = new HttpRequestMessage(HttpMethod.${httpMethod}, "${url}");\n\n        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", "YOUR_API_KEY");${contentSetup}\n\n        var response = await client.SendAsync(request);\n        var content = await response.Content.ReadAsStringAsync();\n        Console.WriteLine(content);\n    }\n}`;
}

function applyLanguageToPlaceholder(endpoint, language) {
    const placeholder = document.getElementById(`${endpoint}-code`);
    const template = endpointCodeTemplates[endpoint] && endpointCodeTemplates[endpoint][language];

    if (!placeholder || !template) return;

    const code = placeholder.querySelector('code');
    if (!code) return;

    code.className = languageSyntaxClasses[language] || template.className || 'language-plaintext';
    code.textContent = template.content;

    // Ensure highlight.js reparses when switching languages.
    code.removeAttribute('data-highlighted');
    code.classList.remove('hljs');

    updateCodeEditorLanguageLabel(endpoint, language);

    if (window.hljs) {
        hljs.highlightElement(code);
    }
}

// Add copy buttons to all code blocks
function addCopyButtonsToCodeBlocks() {
    document.querySelectorAll('pre').forEach(pre => {
        // Skip if already has a copy button
        if (pre.querySelector('.code-copy-btn')) return;
        
        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';

        const codeElement = pre.querySelector('code');
        if (codeElement && codeElement.classList.contains('language-json')) {
            wrapper.classList.add('json-code-block');
        }

        const endpoint = pre.getAttribute('data-endpoint') || getEndpointFromCodeBlock(pre);
        if (endpoint) {
            wrapper.setAttribute('data-endpoint', endpoint);
            wrapper.appendChild(createCodeEditorHeader(endpoint));
        }
        
        // Wrap the pre element
        pre.parentNode.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
        
        // Create copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'code-copy-btn';
        copyBtn.type = 'button';
        copyBtn.title = 'Copy code';
        copyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 2H7C5.9 2 5 2.9 5 4V20C5 21.1 5.9 22 7 22H17C18.1 22 19 21.1 19 20V12M9 7H15M9 12H15M9 17H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        
        // Add click handler
        copyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const codeElement = pre.querySelector('code');
            const codeToCopy = codeElement.textContent;
            
            navigator.clipboard.writeText(codeToCopy).then(() => {
                copyBtn.classList.add('copied');
                copyBtn.title = 'Copied!';
                showToast('Code copied', 'success', 800);
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.title = 'Copy code';
                }, 800);
            }).catch(() => {
                showToast('Copy failed', 'error', 1000);
            });
        });
        
        // Add button to wrapper
        wrapper.appendChild(copyBtn);
    });
}

function getEndpointFromCodeBlock(pre) {
    if (!pre.id || !pre.id.endsWith('-code')) return '';
    return pre.id.replace(/-code$/, '');
}

function createCodeEditorHeader(endpoint) {
    const header = document.createElement('div');
    header.className = 'code-editor-header';

    const dots = document.createElement('div');
    dots.className = 'code-editor-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';

    const language = document.createElement('div');
    language.className = 'code-editor-language';
    const select = document.querySelector(`.language-select[data-endpoint="${endpoint}"]`);
    const langValue = select ? select.value : 'curl';
    language.textContent = languageLabels[langValue] || 'Code';

    header.appendChild(dots);
    header.appendChild(language);
    return header;
}

function updateCodeEditorLanguageLabel(endpoint, language) {
    const wrapper = document.querySelector(`.code-block-wrapper[data-endpoint="${endpoint}"]`);
    if (!wrapper) return;
    const label = wrapper.querySelector('.code-editor-language');
    if (!label) return;
    label.textContent = languageLabels[language] || language;
}

// Setup dynamic code updates when input values change
function setupDynamicCodeUpdates() {
    const testInputs = document.querySelectorAll('.test-input');
    testInputs.forEach(input => {
        input.addEventListener('input', function() {
            const endpoint = this.getAttribute('data-endpoint');
            const param = this.getAttribute('data-param');
            const value = this.value;
            
            updateCodeExamplesForEndpoint(endpoint, param, value);
        });
    });
}

// Update code examples for a specific endpoint and parameter
function updateCodeExamplesForEndpoint(endpoint, param, value) {
    // Get all code blocks for this endpoint
    const codeBlocks = document.querySelectorAll(`[id^="${endpoint}-"]`);
    
    codeBlocks.forEach(codeBlock => {
        if (!codeBlock.id.includes('-response')) {
            const code = codeBlock.querySelector('code');
            if (code) {
                let content = code.textContent;
                
                // Handle different parameter types
                if (param === 'apiKey') {
                    // Replace API key placeholder
                    content = content.replace(/Bearer [^ \n,"}]*/g, `Bearer ${value || 'YOUR_API_KEY'}`);
                    content = content.replace(/'Authorization': 'Bearer [^']*'/g, `'Authorization': 'Bearer ${value || 'YOUR_API_KEY'}'`);
                } else if (param === 'chain') {
                    // Replace chain placeholder
                    content = content.replace(/["']chain["']:\s*["'][A-Z]+["']/g, `"chain": "${value || 'ETH'}"`);
                    content = content.replace(/chain:[^,\n}]*/g, `chain: '${value || 'ETH'}'`);
                } else if (param === 'walletId') {
                    // Replace wallet ID placeholder
                    content = content.replace(/wallet_id/g, value || 'wallet_id');
                    content = content.replace(/wallet_\d+/g, value || 'wallet_id');
                } else if (param === 'transactionId') {
                    // Replace transaction ID placeholder
                    content = content.replace(/transaction_id/g, value || 'transaction_id');
                    content = content.replace(/txn_\d+/g, value || 'transaction_id');
                } else if (param === 'payoutId') {
                    // Replace payout ID placeholder
                    content = content.replace(/payout_id/g, value || 'payout_id');
                    content = content.replace(/payout_\d+/g, value || 'payout_id');
                } else if (param === 'recipientAddress') {
                    // Replace recipient address
                    content = content.replace(/0x[a-fA-F0-9]{20,}/g, value || '0x742d35Cc6634C0532925a3b844Bc122e5d6F0fA6');
                    content = content.replace(/["']recipient[Aa]ddress["']:\s*["'][^"']*["']/g, `"recipientAddress": "${value || '0x742d35...'}"`);
                } else if (param === 'selectedWallets') {
                    // Replace selected wallets
                    content = content.replace(/selectedWallets=[^&\s"]*/g, `selectedWallets=${value || '0xAbc123...'}`);
                } else if (param === 'clientId') {
                    // Replace client ID placeholder where present
                    content = content.replace(/your-client-id/g, value || 'your-client-id');
                }
                
                code.textContent = content;
                
                // Re-highlight if visible
                if (codeBlock.style.display !== 'none' && window.hljs) {
                    hljs.highlightElement(code);
                }
            }
        }
    });
}

// Function to update code examples with actual API URL from config
function updateCodeExamplesWithAPIURL() {
    // Update Base URL display
    const baseUrlDisplay = document.getElementById('base-url-display');
    if (baseUrlDisplay) {
        baseUrlDisplay.textContent = API_URL;
    }
    
    document.querySelectorAll('pre code').forEach(codeBlock => {
        // Replace placeholder URLs with actual API URL from config
        let content = codeBlock.textContent;
        content = content.replace(/https:\/\/api\.etheroute\.io\/api/g, API_URL);
        content = content.replace(/http:\/\/localhost:3000\/api/g, API_URL);
        codeBlock.textContent = content;
    });
}

// Accordion behavior intentionally disabled: endpoint cards are always expanded.

// Sidebar navigation with smooth scroll
const sidebarLinks = document.querySelectorAll('.sidebar-link');

function setActiveSidebarLink(targetLink, smooth = true) {
    if (!targetLink) return;

    sidebarLinks.forEach(link => {
        link.classList.toggle('active', link === targetLink);
    });

    // Keep the active link visible in the scrollable sidebar.
    targetLink.scrollIntoView({
        behavior: smooth ? 'smooth' : 'auto',
        block: 'nearest',
        inline: 'nearest'
    });
}

sidebarLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();

        setActiveSidebarLink(link);
        
        // Smooth scroll to target section with 50px offset for navbar
        const href = link.getAttribute('href');
        if (href && href.startsWith('#')) {
            const targetId = href.substring(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                const elementPosition = targetElement.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementPosition - 60;
                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });
            }
        }
    });
});

// Update active sidebar link while scrolling the content.
const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const id = entry.target.id;
            const matchedLink = Array.from(sidebarLinks).find(
                link => link.getAttribute('data-section') === id
            );
            setActiveSidebarLink(matchedLink);
        }
    });
}, {
    root: null,
    rootMargin: '-100px 0px -66%',
    threshold: 0
});

document.querySelectorAll('.section[id]').forEach(section => {
    sectionObserver.observe(section);
});

// Language selector for code examples
document.querySelectorAll('.language-select').forEach(select => {
    select.addEventListener('change', function() {
        const endpoint = this.getAttribute('data-endpoint');
        const selectedLanguage = this.value;

        applyLanguageToPlaceholder(endpoint, selectedLanguage);
    });
});

// Test Request functionality
document.querySelectorAll('.test-button').forEach(button => {
    button.addEventListener('click', async function() {
        const endpoint = this.getAttribute('data-endpoint');
        const method = this.getAttribute('data-method');
        const urlTemplate = this.getAttribute('data-url');
        
        // Collect input values
        const inputs = {};
        const controls = this.closest('.test-controls');
        controls.querySelectorAll('.test-input').forEach(input => {
            const param = input.getAttribute('data-param');
            const inputEndpoint = input.getAttribute('data-endpoint');
            if (inputEndpoint === endpoint) {
                inputs[param] = input.value;
            }
        });
        
        // Validate required inputs
        const hasApiKey = !!(inputs.apiKey && inputs.apiKey.trim());
        const hasClientId = !!(inputs.clientId && inputs.clientId.trim());

        if (!hasApiKey && !(method !== 'GET' && hasClientId)) {
            alert('Provide either API Key or clientId in body for non-GET requests');
            return;
        }

        const hasBodyOnlyGetInputs = method === 'GET' && Object.keys(inputs).some((param) => {
            if (param === 'apiKey') return false;
            const value = inputs[param];
            return !!value && !urlTemplate.includes(`{${param}}`);
        });

        if (hasBodyOnlyGetInputs) {
            alert('This GET endpoint expects body fields. Browser fetch cannot send GET bodies. Use the cURL example or change this endpoint to POST.');
            return;
        }
        
        // Build URL with parameters using API_URL from config
        let url = API_URL + urlTemplate;
        for (const param in inputs) {
            if (param !== 'apiKey') {
                url = url.replace(`{${param}}`, inputs[param]);
            }
        }
        
        // Set button to loading state
        const originalText = this.textContent;
        this.textContent = 'Testing...';
        this.disabled = true;
        
        try {
            const options = {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            if (hasApiKey) {
                options.headers.Authorization = `Bearer ${inputs.apiKey}`;
            }
            
            // Build request body for POST/PUT/DELETE methods
            if (method !== 'GET') {
                const body = {};
                for (const param in inputs) {
                    if (param !== 'apiKey' && inputs[param] !== '') {
                        body[param] = inputs[param];
                    }
                }
                options.body = JSON.stringify(body);
            }
            
            const response = await fetch(url, options);
            const data = await response.json();
            
            // Display response
            const responseDiv = document.getElementById(`${endpoint}-response`);
            const responseCode = document.getElementById(`${endpoint}-response-code`);
            
            if (responseDiv && responseCode) {
                responseDiv.style.display = 'block';
                responseCode.textContent = JSON.stringify(data, null, 2);
                
                // Highlight the JSON response
                if (window.hljs) {
                    hljs.highlightElement(responseCode);
                }
                
                // Scroll to response
                setTimeout(() => {
                    responseDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 100);
            }
        } catch (error) {
            alert('Error: ' + error.message);
            const responseDiv = document.getElementById(`${endpoint}-response`);
            const responseCode = document.getElementById(`${endpoint}-response-code`);
            
            if (responseDiv && responseCode) {
                responseDiv.style.display = 'block';
                responseCode.textContent = 'Error: ' + error.message;
            }
        } finally {
            // Reset button
            this.textContent = originalText;
            this.disabled = false;
        }
    });
});

// Mobile sidebar toggle
(function () {
    var toggleBtn = document.getElementById('mobileSidebarToggle');
    var sidebar = document.querySelector('.sidebar');
    if (!toggleBtn || !sidebar) return;
    toggleBtn.addEventListener('click', function () {
        var isOpen = sidebar.classList.toggle('mobile-open');
        toggleBtn.classList.toggle('open', isOpen);
    });
    sidebar.addEventListener('click', function (e) {
        if (e.target.closest('a')) {
            sidebar.classList.remove('mobile-open');
            toggleBtn.classList.remove('open');
        }
    });
}());

