// ------------------------------------------------------
// Global state
// ------------------------------------------------------
let map;
let imageLayer;
let markerLayer;
let calibrationPoints = [];
let isCalibrated = false;
let pixelProjection;
let globalCalibration = null;
let developerMode = false;

// ------------------------------------------------------
// Developer Mode detection
// ------------------------------------------------------
function detectDeveloperMode() {
    const urlParams = new URLSearchParams(window.location.search);

    if (urlParams.get("dev") === "1") {
        developerMode = true;
        return;
    }

    if (localStorage.getItem("developerMode") === "true") {
        developerMode = true;
    }
}

function toggleDeveloperMode() {
    developerMode = !developerMode;
    localStorage.setItem("developerMode", developerMode ? "true" : "false");
    location.reload();
}

// ------------------------------------------------------
// Load global calibration.json (unless in dev mode)
// ------------------------------------------------------
async function loadGlobalCalibration() {
    if (developerMode) {
        globalCalibration = null;
        return;
    }

    try {
        const response = await fetch("calibration.json", { cache: "no-store" });
        if (!response.ok) return;
        globalCalibration = await response.json();
    } catch (e) {
        globalCalibration = null;
    }
}

// ------------------------------------------------------
// Initialise on load
// ------------------------------------------------------
window.onload = async () => {
    detectDeveloperMode();
    await loadGlobalCalibration();
    initMap();

    if (developerMode) {
        showBanner("Developer Mode active — raw pixel map.");
        return;
    }

    if (globalCalibration) {
        applyGlobalCalibration();
        showBanner("Map calibrated automatically.");
    } else {
        showBanner("Calibrate the map — tap three points on the plan.");
    }
};

// ------------------------------------------------------
// Map initialisation (pixel projection)
// ------------------------------------------------------
function initMap() {
    const extent = [0, 0, 5000, 7068];

    pixelProjection = new ol.proj.Projection({
        code: "pixel",
        units: "pixels",
        extent: extent
    });

    imageLayer = new ol.layer.Image({
        source: new ol.source.ImageStatic({
            url: "siteplan.jpg",
            imageExtent: extent,
            projection: pixelProjection
        })
    });

    map = new ol.Map({
        target: "map",
        layers: [imageLayer],
        view: new ol.View({
            projection: pixelProjection,
            center: [extent[2] / 2, extent[3] / 2],
            zoom: 2
        }),
        controls: []
    });

    markerLayer = new ol.layer.Vector({
        source: new ol.source.Vector()
    });
    map.addLayer(markerLayer);

    map.on("click", handleMapClick);
}

// ------------------------------------------------------
// Marker helper
// ------------------------------------------------------
function addMarker(coord, label = "") {
    const feature = new ol.Feature({
        geometry: new ol.geom.Point(coord),
        label: label
    });

    feature.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
            radius: 6,
            fill: new ol.style.Fill({ color: "#ffcc00" }),
            stroke: new ol.style.Stroke({ color: "#333", width: 2 })
        }),
        text: new ol.style.Text({
            text: label,
            font: "14px sans-serif",
            fill: new ol.style.Fill({ color: "#000" }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
            offsetY: -15
        })
    }));

    markerLayer.getSource().addFeature(feature);
}

// ------------------------------------------------------
// Handle taps
// ------------------------------------------------------
function handleMapClick(event) {
    const imageXY = event.coordinate;

    if (!isCalibrated) {
        if (calibrationPoints.length >= 3) {
            showBanner("Calibration already has 3 points.");
            return;
        }
        startCalibrationPoint(imageXY);
    } else {
        dropEvent(imageXY);
    }
}

// ------------------------------------------------------
// Start calibration point
// ------------------------------------------------------
function startCalibrationPoint(imageXY) {
    calibrationPoints.push({ imageXY });

    const pointNumber = calibrationPoints.length;

    addMarker(imageXY, String(pointNumber));

    showBottomSheet(`
        <div class="accuracy">Point ${pointNumber} selected</div>
        <button onclick="captureGPS(${pointNumber - 1})">Use my current location</button>
    `);
}

// ------------------------------------------------------
// GPS capture + stabilisation
// ------------------------------------------------------
async function captureGPS(index) {
    showBottomSheet(`
        <div class="accuracy">Improving GPS accuracy…</div>
        <div id="accuracy-readout" class="subtext">Waiting for signal…</div>
    `);

    const gps = await stabiliseGPS();
    calibrationPoints[index].gps = gps;

    showBottomSheet(`
        <div class="accuracy">Accuracy: ±${gps.accuracy.toFixed(1)} m</div>
        <button onclick="saveCalibrationPoint()">Save this point</button>
    `);
}

async function stabiliseGPS() {
    const samples = [];
    const duration = 5000;
    const start = performance.now();

    while (performance.now() - start < duration) {
        const pos = await getGPSReading();
        samples.push(pos);

        document.getElementById("accuracy-readout").innerText =
            `±${pos.accuracy.toFixed(1)} m`;

        await new Promise(r => setTimeout(r, 300));
    }

    samples.sort((a, b) => a.accuracy - b.accuracy);
    return samples[0];
}

function getGPSReading() {
    return new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
            pos => resolve({
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracy: pos.coords.accuracy
            }),
            err => resolve({ lat: 0, lon: 0, accuracy: 999 })
        );
    });
}

// ------------------------------------------------------
// Save calibration point
// ------------------------------------------------------
function saveCalibrationPoint() {
    const last = calibrationPoints[calibrationPoints.length - 1];

    if (!last.gps) {
        showBanner("GPS not captured yet — try again.");
        return;
    }

    hideBottomSheet();

    const count = calibrationPoints.length;

    if (count === 1) {
        showBanner("Great. Walk to a second point far away.");
    } else if (count === 2) {
        showBanner("Nice. Choose a third point to form a triangle.");
    } else if (count === 3) {
        showBanner("Processing calibration…");
        finishCalibration();
    }
}

// ------------------------------------------------------
// Finish calibration
// ------------------------------------------------------
function finishCalibration() {
    if (calibrationPoints.some(p => !p.gps)) {
        showBanner("Calibration error: missing GPS data.");
        return;
    }

    const T = computeAffineTransform(calibrationPoints);

    const json = exportCalibrationJSON(T, calibrationPoints);
    console.log("Calibration JSON:\n", json);

    localStorage.setItem("calibration", JSON.stringify(T));
    isCalibrated = true;

    showBanner("Calibration complete — map aligned.");

    applyTransformToMap(T);
}

// ------------------------------------------------------
// Apply global calibration.json
// ------------------------------------------------------
function applyGlobalCalibration() {
    isCalibrated = true;

    const T = globalCalibration;
    localStorage.setItem("calibration", JSON.stringify(T));

    applyTransformToMap(T);
}

// ------------------------------------------------------
// Apply affine transform to map (GPS mode)
// ------------------------------------------------------
function applyTransformToMap(T) {
    const corners = [
        imageToGPS(0, 0, T),
        imageToGPS(5000, 0, T),
        imageToGPS(0, 7068, T),
        imageToGPS(5000, 7068, T)
    ];

    const minLon = Math.min(...corners.map(c => c.lon));
    const maxLon = Math.max(...corners.map(c => c.lon));
    const minLat = Math.min(...corners.map(c => c.lat));
    const maxLat = Math.max(...corners.map(c => c.lat));

    const gpsExtent = [minLon, minLat, maxLon, maxLat];

    map.setView(new ol.View({
        projection: "EPSG:4326",
        center: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
        zoom: 18
    }));

    imageLayer.setSource(new ol.source.ImageStatic({
        url: "siteplan.jpg",
        imageExtent: gpsExtent,
        projection: "EPSG:4326"
    }));
}

// ------------------------------------------------------
// Drop event after calibration
// ------------------------------------------------------
function dropEvent(imageXY) {
    const T = JSON.parse(localStorage.getItem("calibration"));
    const gps = imageToGPS(imageXY[0], imageXY[1], T);

    addMarker([gps.lon, gps.lat], "E");

    console.log("Event at:", gps);
}

// ------------------------------------------------------
// UI helpers
// ------------------------------------------------------
function showBanner(text) {
    document.getElementById("calibration-banner").innerText = text;
}

function showBottomSheet(html) {
    const sheet = document.getElementById("bottom-sheet");
    document.getElementById("bottom-sheet-content").innerHTML = html;
    sheet.classList.remove("hidden");
}

function hideBottomSheet() {
    document.getElementById("bottom-sheet").classList.add("hidden");
}

// ------------------------------------------------------
// Affine transform
// ------------------------------------------------------
function computeAffineTransform(points) {
    const [p1, p2, p3] = points;

    const A = [
        [p1.imageXY[0], p1.imageXY[1], 1],
        [p2.imageXY[0], p2.imageXY[1], 1],
        [p3.imageXY[0], p3.imageXY[1], 1]
    ];

    const L_lat = [p1.gps.lat, p2.gps.lat, p3.gps.lat];
    const L_lon = [p1.gps.lon, p2.gps.lon, p3.gps.lon];

    const [a, b, c] = solve3x3(A, L_lat);
    const [d, e, f] = solve3x3(A, L_lon);

    return { a, b, c, d, e, f };
}

function solve3x3(A, B) {
    const m = JSON.parse(JSON.stringify(A));
    const v = B.slice();

    for (let i = 0; i < 3; i++) {
        let pivot = m[i][i];
        for (let j = i; j < 3; j++) m[i][j] /= pivot;
        v[i] /= pivot;

        for (let k = 0; k < 3; k++) {
            if (k === i) continue;
            let factor = m[k][i];
            for (let j = i; j < 3; j++) m[k][j] -= factor * m[i][j];
            v[k] -= factor * v[i];
        }
    }

    return v;
}

function imageToGPS(x, y, T) {
    return {
        lat: T.a * x + T.b * y + T.c,
        lon: T.d * x + T.e * y + T.f
    };
}

// ------------------------------------------------------
// Export calibration JSON
// ------------------------------------------------------
function exportCalibrationJSON(T, points) {
    return JSON.stringify({
        a: T.a,
        b: T.b,
        c: T.c,
        d: T.d,
        e: T.e,
        f: T.f,
        points: points
    }, null, 2);
}