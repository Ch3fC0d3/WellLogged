document.documentElement.classList.add("js");

const body = document.body;
const navToggle = document.querySelector("[data-nav-toggle]");
const siteNav = document.querySelector("[data-site-nav]");
const revealItems = document.querySelectorAll(".reveal");
const miniCanvas = document.querySelector(".mini-log-canvas");
const calculator = document.querySelector("[data-calculator]");
const calcLogs = document.querySelector("[data-calc-logs]");
const calcFeet = document.querySelector("[data-calc-feet]");
const calcCurves = document.querySelector("[data-calc-curves]");
const calcTotalFeet = document.querySelector("[data-calc-total-feet]");
const calcCurveFeet = document.querySelector("[data-calc-curve-feet]");
const calcRate = document.querySelector("[data-calc-rate]");
const calcTotalCost = document.querySelector("[data-calc-total-cost]");
const calcMailto = document.querySelector("[data-calc-mailto]");
const calcPresetButtons = document.querySelectorAll("[data-preset-logs]");
let activeCalculatorTier = "Single";
let activeCalculatorRate = 0.69;

function setNav(open) {
  body.classList.toggle("nav-open", open);
  navToggle?.setAttribute("aria-expanded", String(open));
  navToggle?.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
}

navToggle?.addEventListener("click", () => {
  setNav(!body.classList.contains("nav-open"));
});

siteNav?.addEventListener("click", (event) => {
  if (event.target instanceof HTMLAnchorElement) {
    setNav(false);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setNav(false);
  }
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.16 },
  );

  revealItems.forEach((item) => {
    const rect = item.getBoundingClientRect();
    const inInitialViewport = rect.top < window.innerHeight * 0.9 && rect.bottom > 0;

    if (inInitialViewport) {
      item.classList.add("is-visible");
      return;
    }

    observer.observe(item);
  });
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

function drawMiniLog() {
  if (!miniCanvas) return;

  const context = miniCanvas.getContext("2d");
  const width = miniCanvas.width;
  const height = miniCanvas.height;

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(23, 32, 32, 0.1)";
  context.lineWidth = 1;

  for (let x = 0; x <= width; x += 24) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  for (let y = 0; y <= height; y += 20) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  context.strokeStyle = "rgba(23, 32, 32, 0.28)";
  context.lineWidth = 2;

  for (let track = 1; track < 4; track += 1) {
    const x = (width / 4) * track;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }

  const curves = [
    { color: "#0f766e", offset: 0, amplitude: 26 },
    { color: "#c95b2a", offset: 1.6, amplitude: 20 },
    { color: "#d59628", offset: 2.8, amplitude: 18 },
  ];

  curves.forEach((curve, index) => {
    const baseX = (width / 4) * (index + 1) - width / 8;
    context.beginPath();

    for (let y = 12; y <= height - 12; y += 8) {
      const wobble =
        Math.sin(y * 0.045 + curve.offset) * curve.amplitude +
        Math.cos(y * 0.105 + curve.offset) * (curve.amplitude * 0.34);
      const x = baseX + wobble;

      if (y === 12) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.strokeStyle = curve.color;
    context.lineWidth = 3;
    context.stroke();
  });
}

drawMiniLog();

function clampNumber(value, min, max) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) return min;
  return Math.min(Math.max(numericValue, min), max);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function updateCalculator() {
  if (
    !calculator ||
    !calcLogs ||
    !calcFeet ||
    !calcCurves ||
    !calcTotalFeet ||
    !calcCurveFeet ||
    !calcTotalCost
  ) {
    return;
  }

  const logs = Math.round(clampNumber(calcLogs.value, 1, 10000));
  const feetPerLog = Math.round(clampNumber(calcFeet.value, 100, 50000));
  const curvesPerLog = Math.round(clampNumber(calcCurves.value, 1, 100));
  const totalFeet = logs * feetPerLog;
  const totalCurveFeet = totalFeet * curvesPerLog;
  const billableHundreds = Math.ceil(totalCurveFeet / 100);
  const usesCustomPricing = activeCalculatorRate === null;
  const rawTierCost = usesCustomPricing ? null : billableHundreds * activeCalculatorRate;
  const minimumApplied = !usesCustomPricing && logs === 1 && rawTierCost < 29.99;
  const tierCost = minimumApplied ? 29.99 : rawTierCost;

  calcLogs.value = logs;
  calcFeet.value = feetPerLog;
  calcCurves.value = curvesPerLog;
  calcTotalFeet.textContent = `${formatNumber(totalFeet)} ft`;
  calcCurveFeet.textContent = `${formatNumber(totalCurveFeet)} ft`;
  if (calcRate) {
    calcRate.textContent = usesCustomPricing
      ? "Email for pricing"
      : `$${activeCalculatorRate.toFixed(2)} / curve / 100 ft`;
  }
  calcTotalCost.textContent = usesCustomPricing ? "Email for pricing" : formatCurrency(tierCost);

  if (calcMailto) {
    const subject = "Well log digitization estimate";
    const body = [
      "Hello Well Logged,",
      "",
      "I would like a quote for a well log digitization project.",
      "",
      `Selected tier: ${activeCalculatorTier}`,
      `Rate used: ${usesCustomPricing ? "Email for pricing" : `$${activeCalculatorRate.toFixed(2)} per curve per 100 ft`}`,
      `Estimated logs: ${formatNumber(logs)}`,
      `Average feet per log: ${formatNumber(feetPerLog)} ft`,
      `Curves per log: ${formatNumber(curvesPerLog)}`,
      `Well footage: ${formatNumber(totalFeet)} ft`,
      `Curve footage: ${formatNumber(totalCurveFeet)} ft`,
      `One-well minimum applied: ${minimumApplied ? "Yes" : "No"}`,
      `Calculator estimate: ${usesCustomPricing ? "Email for pricing" : formatCurrency(tierCost)}`,
      "",
      "Please let me know the next step.",
    ].join("\n");

    calcMailto.href = `mailto:hello@welllogged.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}

calculator?.addEventListener("submit", (event) => {
  event.preventDefault();
});

[calcLogs, calcFeet, calcCurves].forEach((input) => {
  input?.addEventListener("input", updateCalculator);
  input?.addEventListener("change", updateCalculator);
});

calcPresetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!calcLogs || !calcFeet || !calcCurves) return;

    activeCalculatorTier = button.dataset.presetTier || "Single";
    activeCalculatorRate =
      button.dataset.presetRate === "custom"
        ? null
        : clampNumber(button.dataset.presetRate, 0.01, 100);
    calcLogs.value = button.dataset.presetLogs;
    calcFeet.value = button.dataset.presetFeet;
    calcCurves.value = button.dataset.presetCurves;

    calcPresetButtons.forEach((presetButton) => {
      const isSelected = presetButton === button;
      presetButton.classList.toggle("is-active", isSelected);
      presetButton.setAttribute("aria-pressed", String(isSelected));
    });

    updateCalculator();
  });
});

updateCalculator();
