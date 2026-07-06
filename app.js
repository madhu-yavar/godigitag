const BAGGAGE_VIEWS = [
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "top", label: "Top" },
  { id: "side", label: "Side" },
];

const STORAGE_KEY = "godigitag.baggage-intake.v1";
const CAPTURE_MAX_SIDE = 1280;
const JPEG_QUALITY = 0.82;

const state = {
  activeView: "front",
  stream: null,
  captures: {},
  metadata: {},
};

const elements = {
  activeViewLabel: document.querySelector("#activeViewLabel"),
  analyzeBtn: document.querySelector("#analyzeBtn"),
  cameraFallback: document.querySelector("#cameraFallback"),
  cameraSelect: document.querySelector("#cameraSelect"),
  captureBtn: document.querySelector("#captureBtn"),
  captureCount: document.querySelector("#captureCount"),
  clearBtn: document.querySelector("#clearBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  imageUpload: document.querySelector("#imageUpload"),
  metadataForm: document.querySelector("#metadataForm"),
  photoCanvas: document.querySelector("#photoCanvas"),
  qualityMessage: document.querySelector("#qualityMessage"),
  startCameraBtn: document.querySelector("#startCameraBtn"),
  template: document.querySelector("#viewCardTemplate"),
  video: document.querySelector("#cameraVideo"),
  viewGrid: document.querySelector("#viewGrid"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
};

function init() {
  restoreState();
  renderViewCards();
  renderTabs();
  hydrateForm();
  bindEvents();
  refreshCameraList();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function bindEvents() {
  elements.startCameraBtn.addEventListener("click", () => startCamera());
  elements.captureBtn.addEventListener("click", captureActiveView);
  elements.cameraSelect.addEventListener("change", () => startCamera(elements.cameraSelect.value));
  elements.imageUpload.addEventListener("change", handleUpload);
  elements.clearBtn.addEventListener("click", clearSession);
  elements.analyzeBtn.addEventListener("click", draftMetadata);
  elements.exportBtn.addEventListener("click", exportJson);
  elements.metadataForm.addEventListener("input", persistForm);

  elements.viewTabs.forEach((tab) => {
    tab.addEventListener("click", () => setActiveView(tab.dataset.view));
  });
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    setCameraStatus("Camera API not available in this browser.", "bad");
    showCameraFallback(true);
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter((device) => device.kind === "videoinput");
    elements.cameraSelect.innerHTML = "";

    if (videoDevices.length === 0) {
      const option = new Option("Default camera", "");
      elements.cameraSelect.append(option);
      return;
    }

    videoDevices.forEach((device, index) => {
      const label = device.label || `Camera ${index + 1}`;
      const option = new Option(label, device.deviceId);
      elements.cameraSelect.append(option);
    });
  } catch (error) {
    setCameraStatus("Camera list blocked. Start the camera or use upload.", "warn");
  }
}

async function startCamera(deviceId = elements.cameraSelect.value) {
  stopCamera();
  showCameraFallback(false);
  setCameraStatus("Starting camera...", "");

  const constraints = {
    audio: false,
    video: {
      facingMode: deviceId ? undefined : { ideal: "environment" },
      deviceId: deviceId ? { exact: deviceId } : undefined,
      height: { ideal: 1440 },
      width: { ideal: 1920 },
    },
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    elements.video.srcObject = state.stream;
    elements.captureBtn.disabled = false;
    elements.startCameraBtn.textContent = "Restart Camera";
    setCameraStatus("Camera ready.", "good");
    await refreshCameraList();
  } catch (error) {
    elements.captureBtn.disabled = true;
    showCameraFallback(true);
    setCameraStatus("Camera permission denied or unavailable. Upload a photo instead.", "bad");
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function showCameraFallback(visible) {
  elements.cameraFallback.hidden = !visible;
}

function captureActiveView() {
  const video = elements.video;
  if (!video.videoWidth || !video.videoHeight) {
    setCameraStatus("Camera frame is not ready yet.", "warn");
    return;
  }

  const canvas = elements.photoCanvas;
  const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);

  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const quality = inspectImageQuality(context, canvas.width, canvas.height);
  saveCapture(state.activeView, dataUrl, quality);
}

function handleUpload(event) {
  const [file] = event.target.files;
  if (!file) return;

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    loadImage(reader.result).then((image) => {
      const canvas = elements.photoCanvas;
      const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const quality = inspectImageQuality(context, canvas.width, canvas.height);
      saveCapture(state.activeView, dataUrl, quality);
      elements.imageUpload.value = "";
    });
  });
  reader.readAsDataURL(file);
}

function saveCapture(viewId, dataUrl, quality) {
  state.captures[viewId] = {
    dataUrl,
    quality,
    capturedAt: new Date().toISOString(),
  };

  persistState();
  renderViewCards();
  renderTabs();
  showQuality(quality, `${viewLabel(viewId)} saved`);
  moveToNextMissingView();
}

function inspectImageQuality(context, width, height) {
  const sampleWidth = 96;
  const sampleHeight = Math.max(1, Math.round((height / width) * sampleWidth));
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = sampleWidth;
  sampleCanvas.height = sampleHeight;
  const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
  sampleContext.drawImage(context.canvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;

  let brightness = 0;
  let colorTotal = [0, 0, 0];
  let contrastAccumulator = 0;
  const luminanceValues = [];

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    brightness += luminance;
    colorTotal[0] += red;
    colorTotal[1] += green;
    colorTotal[2] += blue;
    luminanceValues.push(luminance);
  }

  brightness /= luminanceValues.length;

  for (const luminance of luminanceValues) {
    contrastAccumulator += Math.abs(luminance - brightness);
  }

  const contrast = contrastAccumulator / luminanceValues.length;
  const averageColor = colorTotal.map((value) => Math.round(value / luminanceValues.length));
  const issues = [];

  if (brightness < 55) issues.push("low light");
  if (brightness > 218) issues.push("overexposed");
  if (contrast < 18) issues.push("low contrast");

  const status = issues.length === 0 ? "good" : issues.length === 1 ? "warn" : "bad";

  return {
    status,
    brightness: Math.round(brightness),
    contrast: Math.round(contrast),
    dominantColor: rgbToHex(averageColor),
    issues,
  };
}

function showQuality(quality, prefix = "Photo") {
  const issues = quality.issues.length ? `: ${quality.issues.join(", ")}` : "";
  const message = `${prefix}. Brightness ${quality.brightness}, contrast ${quality.contrast}${issues}.`;
  setCameraStatus(message, quality.status);
}

function setCameraStatus(message, tone) {
  elements.qualityMessage.textContent = message;
  elements.qualityMessage.className = `quality-message ${tone || ""}`.trim();
}

function moveToNextMissingView() {
  const next = BAGGAGE_VIEWS.find((view) => !state.captures[view.id]);
  if (next) setActiveView(next.id);
}

function setActiveView(viewId) {
  state.activeView = viewId;
  elements.activeViewLabel.textContent = viewId;
  renderTabs();
}

function renderTabs() {
  const completeCount = BAGGAGE_VIEWS.filter((view) => state.captures[view.id]).length;
  elements.captureCount.textContent = completeCount;

  elements.viewTabs.forEach((tab) => {
    const isActive = tab.dataset.view === state.activeView;
    const isCaptured = Boolean(state.captures[tab.dataset.view]);
    tab.classList.toggle("active", isActive);
    tab.classList.toggle("complete", isCaptured);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

function renderViewCards() {
  elements.viewGrid.innerHTML = "";

  BAGGAGE_VIEWS.forEach((view) => {
    const capture = state.captures[view.id];
    const card = elements.template.content.firstElementChild.cloneNode(true);
    const thumbBtn = card.querySelector(".thumb-btn");
    const img = card.querySelector("img");
    const title = card.querySelector("h3");
    const detail = card.querySelector("p");
    const retakeBtn = card.querySelector(".retake-btn");

    title.textContent = view.label;
    img.alt = `${view.label} baggage view`;

    if (capture) {
      img.src = capture.dataUrl;
      thumbBtn.classList.add("has-image");
      const quality = capture.quality;
      const qualityLabel = quality.issues.length ? quality.issues.join(", ") : "quality ok";
      detail.textContent = `${qualityLabel} · ${formatTime(capture.capturedAt)}`;
      retakeBtn.textContent = "Retake";
    } else {
      detail.textContent = "Required";
      retakeBtn.textContent = "Capture";
    }

    thumbBtn.addEventListener("click", () => setActiveView(view.id));
    retakeBtn.addEventListener("click", () => setActiveView(view.id));
    elements.viewGrid.append(card);
  });
}

async function draftMetadata() {
  const missing = BAGGAGE_VIEWS.filter((view) => !state.captures[view.id]).map((view) => view.label);
  if (missing.length) {
    setCameraStatus(`Missing views: ${missing.join(", ")}.`, "warn");
  }

  const result = await analyzeWithModel({
    captures: state.captures,
    currentForm: readForm(),
  });

  writeForm({
    ...readForm(),
    ...result.metadata,
  });

  state.metadata = readForm();
  persistState();
  setCameraStatus(`Draft metadata created from ${result.source}.`, "good");
}

async function analyzeWithModel(payload) {
  try {
    const response = await fetch("/api/baggage/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return response.json();
    }
  } catch (error) {
    // Local static runs intentionally fall through to the deterministic draft.
  }

  return buildLocalDraft(payload);
}

function buildLocalDraft(payload) {
  const captures = Object.values(payload.captures);
  const colors = captures.map((capture) => capture.quality.dominantColor).filter(Boolean);
  const averageColor = averageHex(colors);

  return {
    source: "local draft",
    metadata: {
      primaryColor: averageColor ? nearestColorName(averageColor) : "",
      texture: payload.currentForm.texture || "Unknown",
      damageStatus: payload.currentForm.damageStatus || "Unknown",
      damageNotes:
        payload.currentForm.damageNotes ||
        "Pending model analysis. Review visible dents, tears, stains, handles, zippers, and wheel housings.",
      distinctiveMarks:
        payload.currentForm.distinctiveMarks ||
        "Pending model analysis. Add stickers, tags, logos, straps, or unique marks.",
      confidence: captures.length === BAGGAGE_VIEWS.length ? "Draft only" : "Incomplete views",
    },
  };
}

function exportJson() {
  const payload = {
    schemaVersion: "1.0",
    createdAt: new Date().toISOString(),
    requiredViews: BAGGAGE_VIEWS.map((view) => view.id),
    images: BAGGAGE_VIEWS.map((view) => {
      const capture = state.captures[view.id];
      return {
        view: view.id,
        capturedAt: capture?.capturedAt || null,
        quality: capture?.quality || null,
        imageDataUrl: capture?.dataUrl || null,
      };
    }),
    metadata: readForm(),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const reference = payload.metadata.referenceId || "baggage-intake";
  anchor.href = url;
  anchor.download = `${reference.replace(/[^a-z0-9-]+/gi, "-").toLowerCase()}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function clearSession() {
  const confirmed = window.confirm("Clear captured images and metadata?");
  if (!confirmed) return;

  state.captures = {};
  state.metadata = {};
  elements.metadataForm.reset();
  localStorage.removeItem(STORAGE_KEY);
  renderViewCards();
  renderTabs();
  setActiveView("front");
  setCameraStatus("Session cleared.", "");
}

function persistForm() {
  state.metadata = readForm();
  persistState();
}

function readForm() {
  return Object.fromEntries(new FormData(elements.metadataForm).entries());
}

function writeForm(metadata) {
  Object.entries(metadata).forEach(([key, value]) => {
    const field = elements.metadataForm.elements[key];
    if (field) field.value = value ?? "";
  });
  state.metadata = readForm();
}

function hydrateForm() {
  writeForm(state.metadata || {});
}

function persistState() {
  const persisted = {
    captures: state.captures,
    metadata: state.metadata,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch (error) {
    setCameraStatus("Browser storage is full. Export JSON before capturing more photos.", "warn");
  }
}

function restoreState() {
  try {
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.captures = persisted.captures || {};
    state.metadata = persisted.metadata || {};
  } catch (error) {
    state.captures = {};
    state.metadata = {};
  }
}

function viewLabel(viewId) {
  return BAGGAGE_VIEWS.find((view) => view.id === viewId)?.label || viewId;
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", reject);
    image.src = src;
  });
}

function rgbToHex([red, green, blue]) {
  return `#${[red, green, blue]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function averageHex(colors) {
  if (!colors.length) return "";
  const totals = colors.reduce(
    (accumulator, color) => {
      const parsed = parseHex(color);
      return [
        accumulator[0] + parsed[0],
        accumulator[1] + parsed[1],
        accumulator[2] + parsed[2],
      ];
    },
    [0, 0, 0],
  );

  return rgbToHex(totals.map((value) => Math.round(value / colors.length)));
}

function parseHex(color) {
  const normalized = color.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function nearestColorName(hex) {
  const [red, green, blue] = parseHex(hex);
  const palette = [
    ["Black", [25, 25, 25]],
    ["Gray", [115, 125, 132]],
    ["Silver", [182, 190, 196]],
    ["White", [236, 238, 236]],
    ["Blue", [40, 94, 169]],
    ["Navy", [18, 44, 88]],
    ["Red", [170, 42, 38]],
    ["Maroon", [101, 31, 41]],
    ["Green", [45, 121, 75]],
    ["Brown", [112, 78, 48]],
    ["Tan", [183, 153, 110]],
    ["Yellow", [207, 173, 54]],
    ["Orange", [201, 104, 43]],
  ];

  const nearest = palette
    .map(([name, color]) => ({
      name,
      distance: Math.hypot(red - color[0], green - color[1], blue - color[2]),
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  return nearest?.name || "Unknown";
}

window.addEventListener("pagehide", stopCamera);

init();
