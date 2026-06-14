const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function clamp(number, min, max) {
  return Math.min(Math.max(number, min), max);
}

function money(centsValue) {
  return currencyFormatter.format(centsValue / 100);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function allocateDiscountShares(items, subtotalCents, discountCents) {
  if (subtotalCents <= 0 || discountCents <= 0) {
    return items.map(() => 0);
  }

  const rawShares = items.map((item, index) => {
    const lineSubtotalCents = item.priceCents * item.quantity;
    const raw = (lineSubtotalCents / subtotalCents) * discountCents;
    const floor = Math.floor(raw);
    return { index, floor, remainder: raw - floor };
  });
  const allocated = rawShares.map((share) => share.floor);
  let remaining = discountCents - allocated.reduce((sum, value) => sum + value, 0);

  rawShares
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((share) => {
      if (remaining <= 0) return;
      allocated[share.index] += 1;
      remaining -= 1;
    });

  return allocated;
}

function calculateRefund({
  items = [],
  discountType = "percent",
  discountValue = 0,
  returnedIds = []
}) {
  const normalizedItems = items
    .filter((item) => item.name || item.price || item.quantity)
    .map((item, index) => ({
      id: item.id || String(index),
      name: item.name || `Item ${index + 1}`,
      priceCents: cents(item.price),
      quantity: Math.max(0, Math.floor(Number(item.quantity) || 0)),
      returnQuantity: Math.max(0, Math.floor(Number(item.returnQuantity) || 0))
    }))
    .filter((item) => item.priceCents > 0 && item.quantity > 0);

  const subtotalCents = normalizedItems.reduce(
    (sum, item) => sum + item.priceCents * item.quantity,
    0
  );

  const rawDiscount =
    discountType === "percent"
      ? Math.round(
          subtotalCents * (clamp(Number(discountValue) || 0, 0, 100) / 100)
        )
      : cents(discountValue);
  const discountCents = clamp(rawDiscount, 0, subtotalCents);

  const returnedSet = new Set(returnedIds);
  const discountShares = allocateDiscountShares(
    normalizedItems,
    subtotalCents,
    discountCents
  );
  const rows = normalizedItems.map((item, index) => {
    const lineSubtotalCents = item.priceCents * item.quantity;
    const discountShareCents = discountShares[index];
    const netLineCents = lineSubtotalCents - discountShareCents;
    const perUnitNetCents = Math.round(netLineCents / item.quantity);
    const returnedQuantity = returnedSet.has(item.id)
      ? Math.min(item.returnQuantity, item.quantity)
      : 0;
    const refundCents = Math.round(
      (netLineCents / item.quantity) * returnedQuantity
    );

    return {
      ...item,
      lineSubtotalCents,
      discountShareCents,
      netLineCents,
      perUnitNetCents,
      returnedQuantity,
      refundCents
    };
  });

  const refundCents = rows.reduce((sum, row) => sum + row.refundCents, 0);

  return {
    subtotalCents,
    discountCents,
    paidCents: subtotalCents - discountCents,
    refundCents,
    rows
  };
}

function formatResultSummary(result) {
  const returnedRows = result.rows.filter((row) => row.returnedQuantity > 0);
  const lines = [
    `Suggested refund: ${money(result.refundCents)}`,
    `Customer paid: ${money(result.paidCents)}`,
    `Order discount allocated: -${money(result.discountCents)}`,
    "",
    "Returned items:"
  ];

  if (returnedRows.length === 0) {
    lines.push("No returned items selected.");
  } else {
    returnedRows.forEach((row) => {
      lines.push(
        `${row.returnedQuantity} x ${row.name} at ${money(row.perUnitNetCents)} = ${money(row.refundCents)}`
      );
    });
  }

  return lines.join("\n");
}

function resultToCsv(result) {
  const header = [
    "Item",
    "Line total",
    "Discount share",
    "Net unit",
    "Returned quantity",
    "Refund"
  ];
  const rows = result.rows.map((row) => [
    row.name,
    money(row.lineSubtotalCents),
    `-${money(row.discountShareCents)}`,
    money(row.perUnitNetCents),
    row.returnedQuantity,
    money(row.refundCents)
  ]);

  return [header, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");
}

function parseItemsFromDom() {
  return [...document.querySelectorAll("[data-item-row]")].map((row) => ({
    id: row.dataset.id,
    name: row.querySelector("[data-name]").value,
    price: row.querySelector("[data-price]").value,
    quantity: row.querySelector("[data-quantity]").value,
    returnQuantity: Number(row.querySelector("[data-return-quantity]").value) || 0
  }));
}

function render() {
  const items = parseItemsFromDom();
  const returnedIds = items
    .filter((item) => item.returnQuantity > 0)
    .map((item) => item.id);
  const result = calculateRefund({
    items,
    discountType: document.querySelector("[name='discountType']:checked").value,
    discountValue: document.querySelector("#discountValue").value,
    returnedIds
  });
  window.currentRefundResult = result;

  document.querySelector("#subtotal").textContent = money(result.subtotalCents);
  document.querySelector("#discount").textContent = `-${money(result.discountCents)}`;
  document.querySelector("#paid").textContent = money(result.paidCents);
  document.querySelector("#refund").textContent = money(result.refundCents);
  document.querySelector("#copyText").value = formatResultSummary(result);

  document.querySelector("#breakdown").innerHTML = result.rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${money(row.lineSubtotalCents)}</td>
          <td>-${money(row.discountShareCents)}</td>
          <td>${money(row.perUnitNetCents)}</td>
          <td>${row.returnedQuantity}</td>
          <td>${money(row.refundCents)}</td>
        </tr>
      `
    )
    .join("");
}

async function copySummary() {
  const copyText = document.querySelector("#copyText");
  copyText.select();
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(copyText.value);
  } else {
    document.execCommand("copy");
  }
  const button = document.querySelector("#copySummary");
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = "Copy summary";
  }, 1200);
}

function downloadCsv() {
  const csv = resultToCsv(window.currentRefundResult);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "refund-breakdown.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function addRow(seed = {}) {
  const list = document.querySelector("#items");
  const id = crypto.randomUUID();
  const template = document.querySelector("#itemTemplate");
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.id = id;
  node.querySelector("[data-name]").value = seed.name || "";
  node.querySelector("[data-price]").value = seed.price || "";
  node.querySelector("[data-quantity]").value = seed.quantity || 1;
  node.querySelector("[data-return-quantity]").value = seed.returnQuantity || 0;
  node.querySelector("[data-remove]").addEventListener("click", () => {
    node.remove();
    render();
  });
  list.appendChild(node);
  render();
}

function boot() {
  [
    { name: "Linen shirt", price: 48, quantity: 2, returnQuantity: 1 },
    { name: "Canvas bag", price: 32, quantity: 1, returnQuantity: 0 },
    { name: "Gift wrap", price: 8, quantity: 1, returnQuantity: 0 }
  ].forEach(addRow);

  document.querySelector("#addItem").addEventListener("click", () => addRow());
  document.querySelector("#copySummary").addEventListener("click", copySummary);
  document.querySelector("#downloadCsv").addEventListener("click", downloadCsv);
  document.addEventListener("input", render);
  render();
}

if (typeof document !== "undefined") {
  boot();
}

if (typeof module !== "undefined") {
  module.exports = {
    allocateDiscountShares,
    calculateRefund,
    cents,
    formatResultSummary,
    resultToCsv
  };
}
