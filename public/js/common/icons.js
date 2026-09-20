// Comprehensive SVG Icon Library for Etheroute

const Icons = {
  // ========== LOGO ==========

  /**
   * The coin. A cylinder turned on its vertical axis and leaning 22 degrees:
   * the face foreshortens to an ellipse, the thickness shows as a reeded
   * crescent, and a bead ring rings the border. The E and its four bars are one
   * skeleton — stroked wide for the body, stroked narrow inside a mask to punch
   * the hollow — so a single continuous outline traces the letter and the bars
   * together, with no seam where they meet.
   *
   * Everything is currentColor, so one mark serves the navbar, the footer and
   * the favicon and follows the theme. The logo this replaces hardcoded its two
   * fills (and shipped three duplicate copies of its own paths), which is why it
   * could not invert.
   *
   * Detail this fine needs pixels: use logoSmall at 32px and below.
   */
  logo: () => `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Etheroute">
    <defs><mask id="etheroute-logo-hollow" maskUnits="userSpaceOnUse" x="-16" y="-16" width="64" height="64">
      <rect x="-16" y="-16" width="64" height="64" fill="#fff"/>
      <g transform="translate(13 16) scale(0.734 1) translate(-16 -16)" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.05 9.15V11.4M17.95 9.15V11.4M14.05 20.6V22.85M17.95 20.6V22.85" stroke-width="2"/>
        <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="1.9"/>
        <path d="M12.4 16H18.4" stroke-width="1.9"/>
      </g>
    </mask></defs>
    <g transform="rotate(22 16 16) translate(16 16) scale(1.111) translate(-16 -16)" stroke="currentColor" stroke-linejoin="round">
      <path d="M13 3.2H18.6A9.4 12.8 0 0 1 18.6 28.8H13A9.4 12.8 0 0 0 13 3.2Z" stroke-width="1.4"/>
      <path d="M14.95 3.48h5.6M16.69 4.23h5.6M18.30 5.42h5.6M19.70 7.02h5.6M20.84 8.95h5.6M21.70 11.15h5.6M22.22 13.53h5.6M22.40 16h5.6M22.22 18.47h5.6M21.70 20.85h5.6M20.84 23.05h5.6M19.70 24.98h5.6M18.30 26.58h5.6M16.69 27.77h5.6M14.95 28.52h5.6" stroke-width="1"/>
      <path d="M13 3.2A9.4 12.8 0 1 1 13 28.8A9.4 12.8 0 1 1 13 3.2Z" stroke-width="1.7"/>
      <g fill="currentColor" stroke="none"><circle cx="21.18" cy="16" r=".42"/><circle cx="20.85" cy="19.14" r=".42"/><circle cx="19.88" cy="22.02" r=".42"/><circle cx="18.36" cy="24.42" r=".42"/><circle cx="16.40" cy="26.13" r=".42"/><circle cx="14.16" cy="27.02" r=".42"/><circle cx="11.84" cy="27.02" r=".42"/><circle cx="9.60" cy="26.13" r=".42"/><circle cx="7.64" cy="24.42" r=".42"/><circle cx="6.12" cy="22.02" r=".42"/><circle cx="5.15" cy="19.14" r=".42"/><circle cx="4.82" cy="16" r=".42"/><circle cx="5.15" cy="12.86" r=".42"/><circle cx="6.12" cy="9.98" r=".42"/><circle cx="7.64" cy="7.58" r=".42"/><circle cx="9.60" cy="5.87" r=".42"/><circle cx="11.84" cy="4.98" r=".42"/><circle cx="14.16" cy="4.98" r=".42"/><circle cx="16.40" cy="5.87" r=".42"/><circle cx="18.36" cy="7.58" r=".42"/><circle cx="19.88" cy="9.98" r=".42"/><circle cx="20.85" cy="12.86" r=".42"/></g>
      <!-- The mask goes on a wrapper with no transform of its own. Put it on
           the same element that carries the placement and the transform lands
           on the hole a second time, because a mask resolves in the user space
           the element's own transform establishes — the hollow then sits offset
           from the letter it is supposed to be cut out of. -->
      <g mask="url(#etheroute-logo-hollow)"><g transform="translate(13 16) scale(0.734 1) translate(-16 -16)" stroke-linecap="round">
        <path d="M14.05 9.15V11.4M17.95 9.15V11.4M14.05 20.6V22.85M17.95 20.6V22.85" stroke-width="3.3"/>
        <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="3.2"/>
        <path d="M12.4 16H18.4" stroke-width="3.2"/>
      </g></g>
    </g>
  </svg>`,

  /**
   * The navbar mark. The hollow letter of the full logo, on the simplified
   * coin: no bead ring, and 6 ridges instead of 15.
   *
   * Size alone could not do this. The hollow rim is 0.65 of a 32-unit viewBox —
   * a sub-pixel line until about 49px — and at the sizes where it finally
   * resolves, 22 beads at 0.84 units and 15 ridges are still sub-pixel, so they
   * grey out into a texture that sits right on top of the thing you are trying
   * to read. Dropping them is what makes the outline legible, not the extra
   * pixels.
   *
   * Full logo for display sizes, this in the header, logoSmall below ~40px.
   */
  logoOutline: () => `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Etheroute">
    <defs><mask id="etheroute-nav-hollow" maskUnits="userSpaceOnUse" x="-16" y="-16" width="64" height="64">
      <rect x="-16" y="-16" width="64" height="64" fill="#fff"/>
      <g transform="translate(13 16) scale(0.734 1) translate(-16 -16)" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.05 9.15V11.4M17.95 9.15V11.4M14.05 20.6V22.85M17.95 20.6V22.85" stroke-width="1.8"/>
        <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="1.7"/>
        <path d="M12.4 16H18.4" stroke-width="1.7"/>
      </g>
    </mask></defs>
    <g transform="rotate(22 16 16) translate(16 16) scale(1.111) translate(-16 -16)" stroke="currentColor" stroke-linejoin="round">
      <path d="M13 3.2H18.6A9.4 12.8 0 0 1 18.6 28.8H13A9.4 12.8 0 0 0 13 3.2Z" stroke-width="1.6"/>
      <path d="M16.52 4.13h5.6M20.09 7.60h5.6M22.12 12.90h5.6M22.12 19.10h5.6M20.09 24.40h5.6M16.52 27.87h5.6" stroke-width="1.4"/>
      <path d="M13 3.2A9.4 12.8 0 1 1 13 28.8A9.4 12.8 0 1 1 13 3.2Z" stroke-width="1.8"/>
      <!-- The mask goes on a wrapper with no transform of its own. Put it on
           the same element that carries the placement and the transform lands
           on the hole a second time, because a mask resolves in the user space
           the element's own transform establishes — the hollow then sits offset
           from the letter it is supposed to be cut out of. -->
      <g mask="url(#etheroute-nav-hollow)"><g transform="translate(13 16) scale(0.734 1) translate(-16 -16)" stroke-linecap="round">
        <path d="M14.05 9.15V11.4M17.95 9.15V11.4M14.05 20.6V22.85M17.95 20.6V22.85" stroke-width="3.3"/>
        <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="3.2"/>
        <path d="M12.4 16H18.4" stroke-width="3.2"/>
      </g></g>
    </g>
  </svg>`,

  /**
   * The same coin drawn for small sizes. Same silhouette, same 22 degree lean,
   * but it stops rendering detail that the pixels cannot hold: the 22 beads go,
   * reeding drops from 15 ridges to 6, the letter is solid rather than hollow,
   * and the bars sit 1.6 apart instead of 0.6 — at 32px a 0.6 gap is 0.6px and
   * the two bars merge into one.
   *
   * Used for the navbar tile, the footer mark and the favicon.
   */
  logoSmall: () => `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Etheroute">
    <g transform="rotate(22 16 16) translate(16 16) scale(1.111) translate(-16 -16)" stroke="currentColor" stroke-linejoin="round">
      <path d="M13 3.2H18.6A9.4 12.8 0 0 1 18.6 28.8H13A9.4 12.8 0 0 0 13 3.2Z" stroke-width="1.8"/>
      <path d="M16.52 4.13h5.6M20.09 7.60h5.6M22.12 12.90h5.6M22.12 19.10h5.6M20.09 24.40h5.6M16.52 27.87h5.6" stroke-width="1.5"/>
      <path d="M13 3.2A9.4 12.8 0 1 1 13 28.8A9.4 12.8 0 1 1 13 3.2Z" stroke-width="2"/>
      <g transform="translate(13 16) scale(0.734 1) translate(-16 -16)" stroke-linecap="round">
        <path d="M13.55 9.15V11.4M18.45 9.15V11.4M13.55 20.6V22.85M18.45 20.6V22.85" stroke-width="3.3"/>
        <path d="M19.6 11.4H12.4V20.6H19.6" stroke-width="3.4"/>
        <path d="M12.4 16H18.4" stroke-width="3.4"/>
      </g>
    </g>
  </svg>`,


  // ========== FEATURE CARD ICONS (Index Page) ==========

  lightning: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  </svg>`,

  checkmark: () => `<svg width="32" height="32" viewBox="-0.5 0 25 25" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M18.92 7.96997C18.9781 7.58275 19.0048 7.19156 19 6.80005C17.8347 5.58901 16.437 4.62559 14.8905 3.96753C13.344 3.30947 11.6806 2.97021 10 2.97021C8.31935 2.97021 6.65602 3.30947 5.10956 3.96753C3.5631 4.62559 2.16532 5.58901 1 6.80005C1 20.86 10 22.97 10 22.97C10.6656 22.6883 11.3077 22.3539 11.92 21.97" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M23 13.97H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path> <path d="M21 10.9199H15C13.8954 10.9199 13 11.8154 13 12.9199V17.9199C13 19.0245 13.8954 19.9199 15 19.9199H21C22.1046 19.9199 23 19.0245 23 17.9199V12.9199C23 11.8154 22.1046 10.9199 21 10.9199Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`,

  smartRouting: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracurrentColorerCarrier" stroke-linecurrentcap="round" stroke-linejoin="round"></g><g id="SVGRepo_icurrentColoronCarrier"> <path d="M19.5 17.5C19.5 18.0523 19.0523 18.5 18.5 18.5C17.9477 18.5 17.5 18.0523 17.5 17.5C17.5 16.9477 17.9477 16.5 18.5 16.5C19.0523 16.5 19.5 16.9477 19.5 17.5Z" fill="currentColor"></path> <path d="M6.5 5.5C6.5 6.05228 6.05228 6.5 5.5 6.5C4.94772 6.5 4.5 6.05228 4.5 5.5C4.5 4.94772 4.94772 4.5 5.5 4.5C6.05228 4.5 6.5 4.94772 6.5 5.5Z" fill="currentColor"></path> <path fill-rule="evenodd" currentclip-rule="evenodd" d="M1.25 5.25732C1.25 2.99429 3.20446 1.25 5.5 1.25C7.79554 1.25 9.75 2.99429 9.75 5.25732C9.75 7.28359 8.50419 9.67508 6.43476 10.5594C5.84021 10.8135 5.15979 10.8135 4.56524 10.5594C2.49581 9.67508 1.25 7.28359 1.25 5.25732ZM5.5 2.75C3.92955 2.75 2.75 3.92241 2.75 5.25732C2.75 6.80078 3.73835 8.57485 5.15469 9.18011C5.37274 9.2733 5.62726 9.2733 5.84531 9.18011C7.26165 8.57485 8.25 6.80078 8.25 5.25732C8.25 3.92241 7.07045 2.75 5.5 2.75ZM11.25 5C11.25 4.58579 11.5858 4.25 12 4.25H16.1319C18.8831 4.25 19.9294 7.843 17.6083 9.32007L7.19703 15.9454C6.14197 16.6168 6.61756 18.25 7.86812 18.25H10.1893L9.96967 18.0303C9.67678 17.7374 9.67678 17.2626 9.96967 16.9697C10.2626 16.6768 10.7374 16.6768 11.0303 16.9697L12.5303 18.4697C12.8232 18.7626 12.8232 19.2374 12.5303 19.5303L11.0303 21.0303C10.7374 21.3232 10.2626 21.3232 9.96967 21.0303C9.67678 20.7374 9.67678 20.2626 9.96967 19.9697L10.1893 19.75H7.86812C5.11688 19.75 4.07062 16.157 6.39172 14.6799L16.803 8.05458C17.858 7.38318 17.3824 5.75 16.1319 5.75H12C11.5858 5.75 11.25 5.41421 11.25 5ZM14.25 17.2573C14.25 14.9943 16.2045 13.25 18.5 13.25C20.7955 13.25 22.75 14.9943 22.75 17.2573C22.75 19.2836 21.5042 21.6751 19.4348 22.5594C18.8402 22.8135 18.1598 22.8135 17.5652 22.5594C15.4958 21.6751 14.25 19.2836 14.25 17.2573ZM18.5 14.75C16.9295 14.75 15.75 15.9224 15.75 17.2573C15.75 18.8008 16.7384 20.5748 18.1547 21.1801C18.3727 21.2733 18.6273 21.2733 18.8453 21.1801C20.2617 20.5748 21.25 18.8008 21.25 17.2573C21.25 15.9224 20.0705 14.75 18.5 14.75Z" fill="currentColor"></path> </g></svg>`,

  barChart: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z" fill="currentColor"/>
  </svg>`,

  userProfile: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" fill="currentColor"/>
  </svg>`,

  globalCheck: () => `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M21 14.5C20.5 14.376 19.6851 14.3714 19 14.376C18.7709 14.3775 18.9094 14.3678 18.6 14.376C17.7926 14.4012 17.0016 14.7368 17 15.6875C16.9982 16.7004 18 17 19 17C20 17 21 17.2312 21 18.3125C21 19.1251 20.1925 19.4812 19.1861 19.5991C18.3861 19.5991 18 19.625 17 19.5M19 20V21M19 13V14M3 12H14M3 12C3 16.9706 7.02944 21 12 21M3 12C3 7.02944 7.02944 3 12 3M12 21C12.338 21 12.6717 20.9814 13 20.9451M12 21C4.75561 13.08 8.98151 5.7 12 3M12 3C15.9187 3 19.2524 5.50442 20.4879 9M12 3C13.3399 4.19853 14.9177 6.31924 15.6246 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`,

  // ========== API REFERENCE SIDEBAR ICONS ==========

  overview: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v6h-6"/>
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-6h6"/>
  </svg>`,

  lock: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>`,

  walletIcon: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
    <line x1="1" y1="10" x2="23" y2="10"/>
  </svg>`,

  transactionsIcon: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="12" y1="2" x2="12" y2="22"/>
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
  </svg>`,

  payouts: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 8v8m-3-3h6"/>
  </svg>`,

  withdraw: () => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path fill-rule="evenodd" clip-rule="evenodd" d="M23 4C23 2.34315 21.6569 1 20 1H4C2.34315 1 1 2.34315 1 4V14C1 15.6569 2.34315 17 4 17H5C5.55228 17 6 16.5523 6 16C6 15.4477 5.55228 15 5 15H4C3.44772 15 3 14.5523 3 14L3 8H21V14C21 14.5523 20.5523 15 20 15H19C18.4477 15 18 15.4477 18 16C18 16.5523 18.4477 17 19 17H20C21.6569 17 23 15.6569 23 14V4ZM21 6V4C21 3.44772 20.5523 3 20 3H4C3.44772 3 3 3.44771 3 4V6H21Z" fill="currentColor"></path> <path d="M13 22C13 22.5523 12.5523 23 12 23C11.4477 23 11 22.5523 11 22L11 16.4069L9.70714 17.6996C9.31657 18.0903 8.68346 18.0903 8.29289 17.6996C7.90239 17.3093 7.90239 16.676 8.29289 16.2856L11.2924 13.2923C11.683 12.9024 12.3156 12.9028 12.7059 13.293L15.705 16.2922C16.0956 16.6828 16.0956 17.3159 15.705 17.7065C15.3145 18.0969 14.6813 18.0969 14.2908 17.7065L13 16.4157L13 22Z" fill="currentColor"></path> </g></svg>`,

  apiKeys: () => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M7 8L3 11.6923L7 16M17 8L21 11.6923L17 16M14 4L10 20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`,

  responses: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`,

  book: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </svg>`,

  // ========== HELP PAGE SIDEBAR ICONS ==========

  gettingStarted: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
  </svg>`,

  security: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>`,

  faq: () => `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <path d="M12 17V16.9929M12 14.8571C12 11.6429 15 12.3571 15 9.85714C15 8.27919 13.6568 7 12 7C10.6567 7 9.51961 7.84083 9.13733 9M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path> </g></svg>`,

  support: () => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>`,

  // ========== SHARED ICONS ==========

  search: () => `<svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
  </svg>`,

  faqChevron: () => `<svg class="faq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>`,

  endpointChevron: () => `<svg class="endpoint-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="6 9 12 15 18 9"/>
  </svg>`,

  // ========== DASHBOARD ICONS (ACTIVELY USED) ==========

  plus: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2"/>
    <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2"/>
  </svg>`,

  close: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2"/>
    <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2"/>
  </svg>`,

  copy: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="9" width="13" height="13" rx="1" stroke="currentColor" stroke-width="2"/>
    <path d="M5 15H4C2.9 15 2 14.1 2 13V4C2 2.9 2.9 2 4 2H13C14.1 2 15 2.9 15 4V5" stroke="currentColor" stroke-width="2"/>
  </svg>`,

  delete: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 18C6 19.1 6.9 20 8 20H16C17.1 20 18 19.1 18 18V6H6V18ZM8 8H16V18H8V8ZM15.5 3L14.5 2H9.5L8.5 3H5V5H19V3H15.5Z" fill="currentColor"/>
  </svg>`,

  logout: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M17 7L15.59 8.41L18.17 11H8V13H18.17L15.59 15.59L17 17L22 12L17 7Z" fill="currentColor"/>
    <path d="M4 5H12V3H4C2.9 3 2 3.9 2 5V19C2 20.1 2.9 21 4 21H12V19H4V5Z" fill="currentColor"/>
  </svg>`,

  check: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="currentColor"/>
  </svg>`,

  alert: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M1 21H23L12 2L1 21ZM13 18H11V16H13V18ZM13 14H11V10H13V14Z" fill="currentColor"/>
  </svg>`,

  edit: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 20h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  search: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
    <path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`,

  chevronDown: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,

  clock: () => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/>
    <path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
};

// Helper function to inject SVGs into elements with data-icon attribute
function loadSVGIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const iconName = el.getAttribute('data-icon');
    if (Icons[iconName]) {
      el.innerHTML = Icons[iconName]();
    }
  });
}

// Run when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadSVGIcons);
} else {
  loadSVGIcons();
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Icons;
}
