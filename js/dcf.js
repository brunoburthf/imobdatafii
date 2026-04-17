/* dcf.js — Calculadora DCF + Premissas Embutidas */

let todosFundos = [];
let premFundoSel = null;
let premSugIdx = -1;

// ─── Carregamento ────────────────────────────────────────────────────────────

async function carregarFundos() {
  try {
    const [r1, r2, r3] = await Promise.all([
      fetch("data/index.json").catch(() => null),
      fetch("data/infra_index.json").catch(() => null),
      fetch("data/agro_index.json").catch(() => null)
    ]);
    if (r1 && r1.ok) {
      const d = await r1.json();
      todosFundos = todosFundos.concat(d.fiis || []);
    }
    if (r2 && r2.ok) {
      const d = await r2.json();
      todosFundos = todosFundos.concat(d.fundos || []);
    }
    if (r3 && r3.ok) {
      const d = await r3.json();
      todosFundos = todosFundos.concat(d.fundos || []);
    }
  } catch (_) {}
}
carregarFundos();

// ─── Navegação entre telas ───────────────────────────────────────────────────

function abrirModo(modo) {
  document.getElementById("dcf-escolha").style.display = "none";
  if (modo === "preco-alvo") {
    document.getElementById("dcf-conteudo").style.display = "flex";
    document.getElementById("dcf-premissas").style.display = "none";
  } else {
    document.getElementById("dcf-conteudo").style.display = "none";
    document.getElementById("dcf-premissas").style.display = "flex";
  }
}

function voltarEscolha() {
  document.getElementById("dcf-conteudo").style.display = "none";
  document.getElementById("dcf-premissas").style.display = "none";
  document.getElementById("dcf-escolha").style.display = "block";
  document.getElementById("dcf-resultado").style.display = "none";
  document.getElementById("prem-resultado").style.display = "none";
}

// ─── DCF Preço-Alvo (inalterado) ─────────────────────────────────────────────

function calcularDCF() {
  const dividendoMensal = parseFloat(document.getElementById("dcf-dividendo").value);
  const crescimentoAnual = parseFloat(document.getElementById("dcf-crescimento").value) / 100;
  const taxaDesconto = parseFloat(document.getElementById("dcf-desconto").value) / 100;
  const horizonte = parseInt(document.getElementById("dcf-horizonte").value);
  const precoAtual = parseFloat(document.getElementById("dcf-preco-atual").value);

  if (isNaN(dividendoMensal) || dividendoMensal <= 0) { alert("Informe o dividendo mensal atual."); return; }
  if (isNaN(crescimentoAnual)) { alert("Informe a taxa de crescimento anual."); return; }
  if (isNaN(taxaDesconto) || taxaDesconto <= 0) { alert("Informe a taxa de desconto anual."); return; }
  if (isNaN(horizonte) || horizonte < 1) { alert("Informe o horizonte de análise."); return; }
  if (taxaDesconto <= crescimentoAnual) { alert("A taxa de desconto deve ser maior que a taxa de crescimento."); return; }

  const dividendoAnual0 = dividendoMensal * 12;
  let vpDividendos = 0;
  for (let t = 1; t <= horizonte; t++) {
    vpDividendos += dividendoAnual0 * Math.pow(1 + crescimentoAnual, t) / Math.pow(1 + taxaDesconto, t);
  }
  const dividendoN1 = dividendoAnual0 * Math.pow(1 + crescimentoAnual, horizonte + 1);
  const valorTerminal = dividendoN1 / (taxaDesconto - crescimentoAnual);
  const vpTerminal = valorTerminal / Math.pow(1 + taxaDesconto, horizonte);
  const precoJusto = vpDividendos + vpTerminal;

  document.getElementById("dcf-preco-justo").textContent = fmtR$(precoJusto);
  document.getElementById("dcf-vp-dividendos").textContent = fmtR$(vpDividendos);
  document.getElementById("dcf-vp-terminal").textContent = fmtR$(vpTerminal);

  const upsideBloco = document.getElementById("dcf-upside-bloco");
  if (!isNaN(precoAtual) && precoAtual > 0) {
    const upside = (precoJusto - precoAtual) / precoAtual * 100;
    const el = document.getElementById("dcf-upside");
    el.textContent = (upside >= 0 ? "+" : "") + upside.toFixed(1) + "%";
    el.style.color = upside >= 0 ? "var(--verde)" : "var(--vermelho)";
    upsideBloco.style.display = "block";
  } else {
    upsideBloco.style.display = "none";
  }
  document.getElementById("dcf-resultado").style.display = "block";
}

// ─── Busca de fundo (premissas) ──────────────────────────────────────────────

function premFiltrar() {
  const q = document.getElementById("prem-busca").value.trim().toUpperCase();
  const box = document.getElementById("prem-sugestoes");
  premSugIdx = -1;
  if (!q) { box.style.display = "none"; return; }
  const res = todosFundos
    .filter(f => ((f["Ticker"]||"").toUpperCase().includes(q) || (f["Nome"]||"").toUpperCase().includes(q)))
    .slice(0, 8);
  if (!res.length) { box.style.display = "none"; return; }
  box.innerHTML = res.map((f, i) =>
    `<div class="sim-sugestao" data-idx="${i}" onmousedown="premSelecionar('${f["Ticker"]}')">
      <span class="sim-sug-ticker">${f["Ticker"]}</span>
      <span class="sim-sug-nome">${f["Nome"] || ""}</span>
    </div>`
  ).join("");
  box._res = res;
  box.style.display = "block";
}

function premNavegar(e) {
  const box = document.getElementById("prem-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;
  if (e.key === "ArrowDown") { e.preventDefault(); premSugIdx = Math.min(premSugIdx + 1, items.length - 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); premSugIdx = Math.max(premSugIdx - 1, 0); }
  else if (e.key === "Enter") { e.preventDefault(); const r = box._res?.[premSugIdx >= 0 ? premSugIdx : 0]; if (r) premSelecionar(r["Ticker"]); return; }
  else if (e.key === "Escape") { box.style.display = "none"; return; }
  items.forEach((el, i) => el.classList.toggle("ativo", i === premSugIdx));
}

function premSelecionar(ticker) {
  const f = todosFundos.find(x => x["Ticker"] === ticker);
  if (!f) return;
  premFundoSel = f;
  document.getElementById("prem-busca").value = ticker;
  document.getElementById("prem-sugestoes").style.display = "none";
  document.getElementById("prem-dados-fundo").style.display = "block";

  document.getElementById("prem-preco").textContent = f["Preço Atual"] != null ? fmtR$(f["Preço Atual"]) : "—";
  document.getElementById("prem-dividendo").textContent = f["Último Dividendo Pago"] != null ? fmtR$(f["Último Dividendo Pago"]) : "—";
  document.getElementById("prem-dy").textContent = f["DY a.a."] != null ? (f["DY a.a."] * 100).toFixed(2) + "%" : "—";

  // Limpa resultados anteriores
  document.getElementById("prem-resultado").style.display = "none";
  ["prem-horizonte", "prem-desconto", "prem-crescimento"].forEach(id => document.getElementById(id).value = "");
}

document.addEventListener("click", e => {
  if (!e.target.closest(".sim-busca-container")) {
    const b = document.getElementById("prem-sugestoes");
    if (b) b.style.display = "none";
  }
});

// ─── DCF model helper ────────────────────────────────────────────────────────

function dcfPreco(divMensal, g, r, n) {
  if (r <= g) return Infinity;
  const d0 = divMensal * 12;
  let vp = 0;
  for (let t = 1; t <= n; t++) {
    vp += d0 * Math.pow(1 + g, t) / Math.pow(1 + r, t);
  }
  const dN1 = d0 * Math.pow(1 + g, n + 1);
  vp += dN1 / ((r - g) * Math.pow(1 + r, n));
  return vp;
}

// ─── Bisseção ────────────────────────────────────────────────────────────────

function bissecar(fn, lo, hi, tol, maxIter) {
  let flo = fn(lo);
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fmid = fn(mid);
    if (Math.abs(fmid) < tol) return mid;
    if ((flo > 0) === (fmid > 0)) { lo = mid; flo = fmid; }
    else { hi = mid; }
  }
  return (lo + hi) / 2;
}

// ─── Calcular premissa ──────────────────────────────────────────────────────

function calcularPremissas() {
  if (!premFundoSel) { alert("Selecione um fundo primeiro."); return; }
  const preco = premFundoSel["Preço Atual"];
  const divMensal = premFundoSel["Último Dividendo Pago"];
  if (!preco || preco <= 0 || !divMensal || divMensal <= 0) {
    alert("O fundo selecionado não tem preço ou dividendo disponível.");
    return;
  }

  const hVal = document.getElementById("prem-horizonte").value;
  const rVal = document.getElementById("prem-desconto").value;
  const gVal = document.getElementById("prem-crescimento").value;

  const h = hVal !== "" ? parseInt(hVal) : null;
  const r = rVal !== "" ? parseFloat(rVal) / 100 : null;
  const g = gVal !== "" ? parseFloat(gVal) / 100 : null;

  const preenchidos = [h !== null, r !== null, g !== null].filter(Boolean).length;
  if (preenchidos !== 2) {
    alert("Preencha exatamente 2 das 3 variáveis. Deixe uma em branco para o cálculo.");
    return;
  }

  let resultLabel = "";
  let resultValue = "";

  if (g === null) {
    // Resolver g (crescimento embutido)
    if (r <= 0) { alert("Taxa de desconto deve ser > 0."); return; }
    const fn = gx => dcfPreco(divMensal, gx, r, h) - preco;
    const gSolv = bissecar(fn, -0.30, r - 0.001, 0.01, 200);
    resultLabel = "Crescimento anual embutido";
    resultValue = (gSolv * 100).toFixed(2) + "% a.a.";
  } else if (r === null) {
    // Resolver r (taxa de desconto embutida)
    const fn = rx => dcfPreco(divMensal, g, rx, h) - preco;
    const rSolv = bissecar(fn, g + 0.001, 1.0, 0.01, 200);
    resultLabel = "Taxa de desconto embutida";
    resultValue = (rSolv * 100).toFixed(2) + "% a.a.";
  } else {
    // Resolver n (horizonte embutido)
    let nSolv = null;
    for (let n = 1; n <= 200; n++) {
      if (dcfPreco(divMensal, g, r, n) >= preco) { nSolv = n; break; }
    }
    if (nSolv === null) {
      resultLabel = "Horizonte embutido";
      resultValue = "> 200 anos (não converge)";
    } else {
      resultLabel = "Horizonte embutido";
      resultValue = nSolv + " anos";
    }
  }

  document.getElementById("prem-res-label").textContent = resultLabel;
  document.getElementById("prem-res-valor").textContent = resultValue;
  document.getElementById("prem-res-preco").textContent = fmtR$(preco);
  document.getElementById("prem-res-div").textContent = fmtR$(divMensal) + "/mês";
  document.getElementById("prem-resultado").style.display = "block";
}

// ─── Util ────────────────────────────────────────────────────────────────────

function fmtR$(v) {
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
