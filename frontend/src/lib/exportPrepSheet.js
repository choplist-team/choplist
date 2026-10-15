import { jsPDF } from "jspdf";
import DejaVuSans from "@/assets/fonts/DejaVuSans.ttf?inline";

const COLORS = {
  primary: [49, 91, 64],
  foreground: [36, 43, 36],
  muted: [114, 118, 107],
  background: [255, 253, 248],
  softGreen: [232, 238, 226],
  border: [225, 225, 214],
  warning: [250, 237, 215],
  warningText: [139, 90, 32],
  white: [255, 255, 255],
};

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 18;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function setFont(doc, style = "normal") {
  doc.setFont("DejaVuSans", style);
}

function setHeading(doc, size) {
  setFont(doc, "normal");
  doc.setFontSize(size);
  doc.setTextColor(...COLORS.foreground);
}

function registerFonts(doc) {
  const commaIndex = DejaVuSans.indexOf(",");
  const fontBase64 =
    commaIndex >= 0 ? DejaVuSans.slice(commaIndex + 1) : DejaVuSans;

  doc.addFileToVFS("DejaVuSans.ttf", fontBase64);
  doc.addFont("DejaVuSans.ttf", "DejaVuSans", "normal");
  doc.addFont("DejaVuSans.ttf", "DejaVuSans", "bold");
  setFont(doc);
}

function formatPrice(amount) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Number(amount) || 0);
}

function formatDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

async function loadChopListLogo() {
  const response = await fetch("/choplist-pwa-512x512.png");

  if (!response.ok) {
    throw new Error("Could not load the ChopList logo.");
  }

  const blob = await response.blob();

  if (blob.type !== "image/png") {
    throw new Error("The ChopList logo could not be loaded as a PNG.");
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error("Could not read the ChopList logo."));

    reader.readAsDataURL(blob);
  });
}

function drawRoundedCard(
  doc,
  x,
  y,
  width,
  height,
  fillColor,
  borderColor = fillColor,
  radius = 5
) {
  doc.setFillColor(...fillColor);
  doc.setDrawColor(...borderColor);
  doc.setLineWidth(0.25);

  doc.roundedRect(x, y, width, height, radius, radius, "FD");
}

function drawHeader(doc, logoData, businessName, menuTitle, paidOnly) {
  const logoSize = 13;

  if (logoData) {
    doc.addImage(logoData, "PNG", MARGIN, 9, logoSize, logoSize);
  }

  setHeading(doc, 17);
  doc.setTextColor(...COLORS.primary);
  doc.text("choplist", MARGIN + logoSize + 3, 17.5);

  setFont(doc, "normal");
  doc.setFontSize(9);
  doc.setTextColor(...COLORS.foreground);

  doc.text(
    doc.splitTextToSize(businessName || "ChopList Seller", 65),
    PAGE_WIDTH - MARGIN,
    13,
    { align: "right" }
  );

  setHeading(doc, 24);
  doc.text("Cook the right amount.", MARGIN, 37);

  setFont(doc, "normal");
  doc.setFontSize(12);
  doc.setTextColor(...COLORS.muted);

  doc.text(
    doc.splitTextToSize(menuTitle || "Preparation sheet", 125),
    MARGIN,
    45
  );

  setFont(doc, "normal");
  doc.setFontSize(9);
  doc.setTextColor(...COLORS.muted);

  doc.text(`GENERATED ${formatDate()}`.toUpperCase(), MARGIN, 57);

  const filterLabel = paidOnly
    ? "PAID ORDERS ONLY"
    : "ALL NON-CANCELLED ORDERS";

  doc.text(filterLabel, PAGE_WIDTH - MARGIN, 57, {
    align: "right",
  });
}

function drawSummary(doc, totals, startY) {
  const x = MARGIN;
  const y = startY;
  const width = CONTENT_WIDTH;
  const height = 58;

  drawRoundedCard(
    doc,
    x,
    y,
    width,
    height,
    COLORS.softGreen,
    COLORS.softGreen,
    6
  );

  setFont(doc, "normal");
  doc.setFontSize(11);
  doc.setTextColor(...COLORS.primary);
  doc.text("Portions to prepare", x + 7, y + 13);

  setFont(doc, "normal");
  doc.setFontSize(30);
  doc.setTextColor(...COLORS.primary);
  doc.text(String(totals.portions ?? 0), x + 7, y + 28);

  setFont(doc, "normal");
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.foreground);

  const orderCount = Number(totals.orders) || 0;

  doc.text(
    `${orderCount} ${orderCount === 1 ? "order" : "orders"} included`,
    x + 7,
    y + 37
  );

  doc.setDrawColor(...COLORS.border);
  doc.setLineWidth(0.3);
  doc.line(x + 7, y + 44, x + width - 7, y + 44);

  setFont(doc, "normal");
  doc.setFontSize(10);
  doc.setTextColor(...COLORS.foreground);
  doc.text("Expected order total", x + 7, y + 55);

  setFont(doc, "bold");
  doc.setFontSize(13);
  doc.setTextColor(...COLORS.foreground);
  doc.text(formatPrice(totals.amount), x + width - 7, y + 55, {
    align: "right",
  });

  return y + height;
}

function drawSectionTitle(doc, title, y) {
  setHeading(doc, 13);
  doc.text(title, MARGIN, y);

  return y + 8;
}

function drawItemCard(doc, item, y) {
  const x = MARGIN;
  const width = CONTENT_WIDTH;
  const cardHeight = 23;

  if (y + cardHeight > PAGE_HEIGHT - 25) {
    doc.addPage();
    y = 20;
  }

  drawRoundedCard(doc, x, y, width, cardHeight, COLORS.white, COLORS.border, 3);

  setHeading(doc, 11);

  const itemName = doc.splitTextToSize(item.name || "Unnamed item", width - 48);

  doc.text(itemName.slice(0, 2), x + 5, y + 9);

  setFont(doc, "normal");
  doc.setFontSize(8);
  doc.setTextColor(...COLORS.foreground);

  const itemOrders = Number(item.orders) || 0;
  const itemPortions = Number(item.portions) || 0;

  doc.text(
    `${itemOrders} ${itemOrders === 1 ? "order" : "orders"} · ${itemPortions} ${
      itemPortions === 1 ? "portion" : "portions"
    }`,
    x + 5,
    y + 17
  );

  setFont(doc, "normal");
  doc.setFontSize(15);
  doc.setTextColor(...COLORS.primary);

  doc.text(String(itemPortions), x + width - 5, y + 13, { align: "right" });

  return y + cardHeight + 3;
}

function drawFooter(doc) {
  const pageCount = doc.getNumberOfPages();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);

    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.25);
    doc.line(MARGIN, PAGE_HEIGHT - 15, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 15);

    setFont(doc, "normal");
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.muted);

    doc.text("Prepared with ChopList", MARGIN, PAGE_HEIGHT - 9);

    doc.text(
      `Page ${page} of ${pageCount}`,
      PAGE_WIDTH - MARGIN,
      PAGE_HEIGHT - 9,
      { align: "right" }
    );
  }
}

export async function exportPrepSheet({
  businessName = "ChopList Seller",
  menuTitle = "Preparation sheet",
  items = [],
  totals = {},
  paidOnly = false,
}) {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  registerFonts(doc);

  const logoData = await loadChopListLogo();

  doc.setFillColor(...COLORS.background);
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, "F");

  drawHeader(doc, logoData, businessName, menuTitle, paidOnly);

  let y = drawSummary(doc, totals, 67);
  y += 13;

  y = drawSectionTitle(doc, "What to prepare", y);

  if (items.length === 0) {
    drawRoundedCard(
      doc,
      MARGIN,
      y,
      CONTENT_WIDTH,
      25,
      COLORS.white,
      COLORS.border,
      4
    );

    setFont(doc, "normal");
    doc.setFontSize(10);
    doc.setTextColor(...COLORS.foreground);
    doc.text(
      "No items are available for this preparation sheet.",
      MARGIN + 5,
      y + 14
    );
  } else {
    items.forEach((item) => {
      y = drawItemCard(doc, item, y);
    });
  }

  drawFooter(doc);

  const safeBusinessName = String(businessName || "ChopList")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  const safeMenuTitle = String(menuTitle || "prep-sheet")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  doc.save(
    `${safeBusinessName || "ChopList"}-${safeMenuTitle || "prep-sheet"}.pdf`
  );
}
