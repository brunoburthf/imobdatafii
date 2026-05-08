let fundos = [];
let colunaOrdem = null;
let ordemAsc = true;

const COLUNAS_NUMERICAS = ["Preço Atual", "VP/cota", "Variação Dia", "P/VP", "DY a.a.", "Retorno - MTD", "Retorno - 12M", "Último Dividendo Pago"];

// prices.json (GH Action a cada 5min) inclui FIIs + Fiagros + Infras
function urlPrecos() {
  return "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json?t=" + Math.floor(Date.now() / 60000);
}
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function aplicarPrecosLive(precos) {
  if (!precos || !precos.precos) return false;
  fundos.forEach(f => {
    const t = f["Ticker"];
    if (precos.precos?.[t] != null) f["Preço Atual"] = precos.precos[t];
    if (precos.variacoes?.[t] != null) f["Variação Dia"] = precos.variacoes[t];
    const vp = f["VP/cota"];
    if (vp && vp > 0 && typeof f["Preço Atual"] === "number") {
      f["P/VP"] = f["Preço Atual"] / vp;
    }
  });
  return true;
}

async function fetchPrecosLive() {
  try {
    const r = await fetch(urlPrecos());
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function carregarDados() {
  try {
    const [resp, precos] = await Promise.all([
      fetch("data/agro_index.json?v=" + Date.now()),
      fetchPrecosLive()
    ]);
    if (!resp.ok) throw new Error("agro_index.json não encontrado. Rode Atualizar Dados.");
    const data = await resp.json();
    fundos = data.fundos || [];
    if (precos) aplicarPrecosLive(precos);

    if (data.atualizado_em) {
      document.getElementById("ultima-atualizacao").textContent = "Atualizado em " + data.atualizado_em;
    }

    popularFiltroTipo();
    renderizarTabela(fundos);

    document.getElementById("loading").style.display = "none";
    document.getElementById("tabela-wrapper").style.display = "block";

    iniciarPollingPrecos();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

let _pollingHandle = null;
function iniciarPollingPrecos() {
  if (_pollingHandle) return;
  const refresh = async () => {
    const precos = await fetchPrecosLive();
    if (!precos) return;
    aplicarPrecosLive(precos);
    if (typeof filtrarTabela === "function") filtrarTabela();
    else renderizarTabela(fundos);
  };
  _pollingHandle = setInterval(refresh, REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

function popularFiltroTipo() {
  const tipos = [...new Set(fundos.map(f => f["Tipo"]).filter(Boolean))].sort();
  const sel = document.getElementById("filtro-tipo");
  tipos.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  });
}

function filtrarTabela() {
  const busca = document.getElementById("busca").value.toLowerCase();
  const tipo  = document.getElementById("filtro-tipo").value;

  const parseNum = id => {
    const v = document.getElementById(id)?.value;
    const n = v === "" || v == null ? null : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const pvpMin = parseNum("fav-pvp-min");
  const pvpMax = parseNum("fav-pvp-max");
  const dyMin  = parseNum("fav-dy-min");
  const dyMax  = parseNum("fav-dy-max");

  let lista = fundos.filter(f => {
    const matchBusca = !busca ||
      (f["Ticker"] || "").toLowerCase().includes(busca) ||
      (f["Nome"]   || "").toLowerCase().includes(busca);
    const matchTipo = !tipo || f["Tipo"] === tipo;

    const pvp = typeof f["P/VP"] === "number" ? f["P/VP"] : null;
    const matchPvpMin = pvpMin == null || (pvp != null && pvp >= pvpMin);
    const matchPvpMax = pvpMax == null || (pvp != null && pvp <= pvpMax);

    const dy = typeof f["DY a.a."] === "number" ? f["DY a.a."] * 100 : null;
    const matchDyMin = dyMin == null || (dy != null && dy > dyMin);
    const matchDyMax = dyMax == null || (dy != null && dy < dyMax);

    return matchBusca && matchTipo && matchPvpMin && matchPvpMax && matchDyMin && matchDyMax;
  });

  if (colunaOrdem) lista = ordenarLista(lista, colunaOrdem);
  renderizarTabela(lista);
}

function toggleFiltroAvancado() {
  const card = document.getElementById("filtro-avancado-card");
  const btn  = document.getElementById("btn-filtro-avancado");
  const aberto = card.style.display !== "none";
  card.style.display = aberto ? "none" : "flex";
  btn.classList.toggle("ativo", !aberto);
}
function limparFiltroAvancado() {
  ["fav-pvp-min","fav-pvp-max","fav-dy-min","fav-dy-max"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  filtrarTabela();
}

function ordenar(coluna) {
  if (colunaOrdem === coluna) ordemAsc = !ordemAsc;
  else { colunaOrdem = coluna; ordemAsc = true; }
  filtrarTabela();
}

function ordenarLista(lista, coluna) {
  return [...lista].sort((a, b) => {
    let va = a[coluna], vb = b[coluna];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return ordemAsc ? va - vb : vb - va;
    return ordemAsc
      ? String(va).localeCompare(String(vb), "pt-BR")
      : String(vb).localeCompare(String(va), "pt-BR");
  });
}

function formatarValor(coluna, valor) {
  if (valor == null || valor === "") return "—";
  if (!COLUNAS_NUMERICAS.includes(coluna)) return valor;
  const num = parseFloat(valor);
  if (isNaN(num)) return valor;
  if (coluna === "Preço Atual" || coluna === "VP/cota") return "R$ " + num.toFixed(2);
  if (coluna === "P/VP") return num.toFixed(2) + "x";
  if (coluna === "Variação Dia") return (num >= 0 ? "+" : "") + num.toFixed(2) + "%";
  if (coluna === "DY a.a." || coluna === "Retorno - MTD" || coluna === "Retorno - 12M") return (num * 100).toFixed(2) + "%";
  if (coluna === "Último Dividendo Pago") return "R$ " + num.toFixed(2);
  return num.toFixed(2);
}

function classeValor(coluna, valor) {
  if (!["Retorno - MTD","Retorno - 12M","Variação Dia"].includes(coluna)) return "";
  const num = parseFloat(valor);
  if (isNaN(num)) return "";
  return num >= 0 ? "positivo" : "negativo";
}

function renderizarTabela(lista) {
  const tbody = document.getElementById("tabela-body");
  tbody.innerHTML = "";

  const colunas = ["Ticker","Nome","Preço Atual","VP/cota","Variação Dia","P/VP","DY a.a.","Retorno - MTD","Retorno - 12M","Último Dividendo Pago"];

  lista.forEach(f => {
    const tr = document.createElement("tr");
    tr.onclick = () => { window.location.href = "agro_fundo.html?ticker=" + encodeURIComponent(f["Ticker"]); };

    colunas.forEach(col => {
      const td = document.createElement("td");
      const val = f[col];
      const isNum = COLUNAS_NUMERICAS.includes(col);
      if (col === "Ticker") td.className = "ticker-cell";
      else if (isNum) td.className = "num " + classeValor(col, val);
      td.textContent = formatarValor(col, val);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  document.getElementById("contagem").textContent = lista.length + " fundos exibidos";
}

carregarDados();
