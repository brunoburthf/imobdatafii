// Exibe elementos .val-restrito apenas em localhost
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  document.querySelectorAll('.val-restrito').forEach(el => el.style.display = '');
}
