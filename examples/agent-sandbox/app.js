(function () {
  const counterEl = document.getElementById('counter');
  const btn = document.getElementById('inc-btn');
  let n = 0;

  function render() {
    if (counterEl) counterEl.textContent = String(n);
  }

  if (btn) {
    btn.addEventListener('click', function () {
      n += 1;
      render();
    });
  }

  render();
})();
