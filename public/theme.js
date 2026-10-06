// Runs before first paint: apply the remembered theme so a dark-mode visitor never sees a white flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('est:theme'); } catch (e) {}
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
