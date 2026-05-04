// Notícias — renderiza UM card (Dividendos | Fatos | Relatórios) baseado no
// atributo data-card do <main>. Lê data/noticias.json (gerado por
// scripts/coletar_noticias_fnet.py).

async function carregarDados() {
  const card = document.querySelector("main[data-card]")?.dataset.card;
  if (!card) return;
  try {
    const resp = await fetch("data/noticias.json");
    if (!resp.ok) throw new Error("Dados não encontrados. Rode scripts/coletar_noticias_fnet.py primeiro.");
    const data = await resp.json();

    document.getElementById("atualizado-em").textContent = data.atualizado_em || "—";
    document.getElementById("janela-dias").textContent   = data.janela_dias || 30;

    if      (card === "dividendos") renderDividendos(data.dividendos || []);
    else if (card === "fatos")      renderFatos(data.fatos_relevantes || []);
    else if (card === "relatorios") renderRelatorios(data.relatorios_gerenciais || []);

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// ─── DIVIDENDOS: lista filtrável por setor / ticker / data com / pagto ──────

let _todosDividendos = [];
let _filtradosAtuais = [];
let _ordem = { campo: "data_anuncio", direcao: "desc" };

// Campos numéricos ou de data: ao mudar pra eles, default é desc (mais
// recente / maior primeiro). Strings começam asc.
const _CAMPOS_DESC_DEFAULT = new Set([
  "valor", "variacao_pct", "data_com", "data_pagamento", "data_anuncio",
]);

function renderDividendos(lista) {
  _todosDividendos = lista.slice();  // ordem aplicada em aplicarFiltros
  popularSelectSetor(_todosDividendos);
  aplicarFiltros();
}

function popularSelectSetor(lista) {
  const setores = [...new Set(lista.map(a => a.setor).filter(Boolean))].sort();
  const sel = document.getElementById("filtro-setor");
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos os setores</option>' +
    setores.map(s => `<option value="${s}">${s}</option>`).join("");
}

function aplicarFiltros() {
  const setor   = document.getElementById("filtro-setor")?.value || "";
  const tickerQ = (document.getElementById("filtro-ticker")?.value || "").trim().toUpperCase();
  const comDe   = document.getElementById("filtro-com-de")?.value  || "";
  const comAte  = document.getElementById("filtro-com-ate")?.value || "";
  const pgtoDe  = document.getElementById("filtro-pgto-de")?.value  || "";
  const pgtoAte = document.getElementById("filtro-pgto-ate")?.value || "";
  const anunDe  = document.getElementById("filtro-anun-de")?.value  || "";
  const anunAte = document.getElementById("filtro-anun-ate")?.value || "";

  const filtrados = _todosDividendos.filter(a => {
    if (setor && a.setor !== setor) return false;
    if (tickerQ && !a.ticker.toUpperCase().includes(tickerQ)) return false;
    if (comDe   && (a.data_com       || "") < comDe)   return false;
    if (comAte  && (a.data_com       || "") > comAte)  return false;
    if (pgtoDe  && (a.data_pagamento || "") < pgtoDe)  return false;
    if (pgtoAte && (a.data_pagamento || "") > pgtoAte) return false;
    // data_anuncio é ISO com timestamp ("2026-04-30T18:07:00") — compara só a data
    const anuncDate = (a.data_anuncio || "").slice(0, 10);
    if (anunDe  && anuncDate < anunDe)  return false;
    if (anunAte && anuncDate > anunAte) return false;
    return true;
  });

  ordenarLista(filtrados);
  atualizarIconesSort();
  _filtradosAtuais = filtrados;

  document.getElementById("dividendos-count").textContent =
    `${filtrados.length} de ${_todosDividendos.length} anúncios`;

  const tbody = document.getElementById("tabela-dividendos-body");
  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="sim-vazio-msg">Nenhum resultado para os filtros aplicados.</td></tr>';
    return;
  }
  tbody.innerHTML = filtrados.map(a => `
    <tr>
      <td><a href="fii.html?ticker=${a.ticker}" class="ticker-cell">${a.ticker}</a></td>
      <td class="noticias-nome" title="${a.nome_fundo || ""}">${a.nome_fundo || "—"}</td>
      <td>${a.setor || "—"}</td>
      <td class="num">${formatarValor(a.valor)}</td>
      <td class="num">${formatarVariacao(a.variacao_pct, a.valor_anterior)}</td>
      <td class="num">${formatarData(a.data_com)}</td>
      <td class="num">${formatarData(a.data_pagamento)}</td>
      <td class="num">
        <a href="${a.url_fnet}" target="_blank" rel="noopener" class="noticias-link">
          ${formatarDataHora(a.data_anuncio)}
        </a>
      </td>
    </tr>
  `).join("");
}

function limparFiltros() {
  ["filtro-setor","filtro-ticker",
   "filtro-com-de","filtro-com-ate",
   "filtro-pgto-de","filtro-pgto-ate",
   "filtro-anun-de","filtro-anun-ate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  aplicarFiltros();
}

function baixarPlanilha() {
  if (!_filtradosAtuais.length) {
    alert("Nada para exportar — a lista filtrada está vazia.");
    return;
  }
  const cols = [
    ["Ticker",         a => a.ticker],
    ["Fundo",          a => a.nome_fundo || ""],
    ["Setor",          a => a.setor || ""],
    ["Tipo",           a => a.tipo_provento || ""],
    ["Valor (R$)",     a => a.valor != null ? a.valor.toFixed(6).replace(".", ",") : ""],
    ["Anterior (R$)",  a => a.valor_anterior != null ? a.valor_anterior.toFixed(6).replace(".", ",") : ""],
    ["Variação",       a => a.variacao_pct != null ? (a.variacao_pct*100).toFixed(2).replace(".", ",") + "%" : ""],
    ["Data com",       a => a.data_com || ""],
    ["Pagamento",      a => a.data_pagamento || ""],
    ["Anúncio",        a => (a.data_anuncio || "").replace("T", " ").slice(0, 16)],
    ["Isento IR",      a => a.isento_ir ? "Sim" : "Não"],
    ["URL fnet",       a => a.url_fnet || ""],
  ];
  const escapar = v => {
    const s = String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [
    cols.map(c => c[0]).join(";"),
    ..._filtradosAtuais.map(a => cols.map(c => escapar(c[1](a))).join(";"))
  ];
  // BOM UTF-8 pro Excel reconhecer acentos
  const csv = "﻿" + linhas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const hoje = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dividendos_imobdata_${hoje}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function filtrarAnuncioHoje() {
  const hoje = new Date();
  const iso = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,"0")}-${String(hoje.getDate()).padStart(2,"0")}`;
  const de  = document.getElementById("filtro-anun-de");
  const ate = document.getElementById("filtro-anun-ate");
  if (de)  de.value  = iso;
  if (ate) ate.value = iso;
  aplicarFiltros();
}

// ─── Sort por cabeçalho ─────────────────────────────────────────────────────

function ordenar(campo) {
  if (_ordem.campo === campo) {
    _ordem.direcao = _ordem.direcao === "asc" ? "desc" : "asc";
  } else {
    _ordem.campo = campo;
    _ordem.direcao = _CAMPOS_DESC_DEFAULT.has(campo) ? "desc" : "asc";
  }
  aplicarFiltros();
}

function ordenarLista(arr) {
  const { campo, direcao } = _ordem;
  const sinal = direcao === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    const va = chaveSort(campo, a[campo]);
    const vb = chaveSort(campo, b[campo]);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;   // nulls sempre no fim
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sinal;
    return String(va).localeCompare(String(vb), "pt-BR") * sinal;
  });
}

function chaveSort(campo, val) {
  if (val == null || val === "") return null;
  return val;
}

function atualizarIconesSort() {
  document.querySelectorAll('main[data-card="dividendos"] th[data-sort]').forEach(th => {
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (th.dataset.sort === _ordem.campo) {
      icon.textContent = _ordem.direcao === "asc" ? "▲" : "▼";
      th.classList.add("sort-ativo");
    } else {
      icon.textContent = "↕";
      th.classList.remove("sort-ativo");
    }
  });
}

// ─── FATOS RELEVANTES E COMUNICADOS: lista filtrável ───────────────────────

let _todosFatos = [];
let _filtradosFatosAtuais = [];
let _ordemFatos = { campo: "data_anuncio", direcao: "desc" };

function renderFatos(lista) {
  _todosFatos = lista.slice();
  popularSelectSetorFatos(_todosFatos);
  aplicarFiltrosFatos();
}

function popularSelectSetorFatos(lista) {
  const setores = [...new Set(lista.map(a => a.setor).filter(Boolean))].sort();
  const sel = document.getElementById("fatos-filtro-setor");
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos os setores</option>' +
    setores.map(s => `<option value="${s}">${s}</option>`).join("");
}

function aplicarFiltrosFatos() {
  const setor   = document.getElementById("fatos-filtro-setor")?.value || "";
  const tickerQ = (document.getElementById("fatos-filtro-ticker")?.value || "").trim().toUpperCase();
  const cat     = document.getElementById("fatos-filtro-categoria")?.value || "";
  const anunDe  = document.getElementById("fatos-filtro-anun-de")?.value  || "";
  const anunAte = document.getElementById("fatos-filtro-anun-ate")?.value || "";

  const filtrados = _todosFatos.filter(a => {
    if (setor && a.setor !== setor) return false;
    if (tickerQ && !a.ticker.toUpperCase().includes(tickerQ)) return false;
    if (cat && a.categoria !== cat) return false;
    const anuncDate = (a.data_anuncio || "").slice(0, 10);
    if (anunDe  && anuncDate < anunDe)  return false;
    if (anunAte && anuncDate > anunAte) return false;
    return true;
  });

  ordenarListaFatos(filtrados);
  atualizarIconesSortFatos();
  _filtradosFatosAtuais = filtrados;

  document.getElementById("fatos-count").textContent =
    `${filtrados.length} de ${_todosFatos.length} doc${_todosFatos.length !== 1 ? "s" : ""}`;

  const tbody = document.getElementById("tabela-fatos-body");
  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="sim-vazio-msg">Nenhum resultado para os filtros aplicados.</td></tr>';
    return;
  }
  tbody.innerHTML = filtrados.map(a => `
    <tr>
      <td><a href="fii.html?ticker=${a.ticker}" class="ticker-cell">${a.ticker}</a></td>
      <td class="noticias-nome" title="${a.nome_fundo || ""}">${a.nome_fundo || "—"}</td>
      <td>${a.setor || "—"}</td>
      <td>
        <span class="noticias-badge ${badgeClasse(a.categoria)}">${a.categoria || "—"}</span>
        ${a.especie ? `<span class="noticias-especie">${a.especie}</span>` : ""}
      </td>
      <td class="num">
        <a href="${a.url_fnet}" target="_blank" rel="noopener" class="noticias-link">
          ${formatarDataHora(a.data_anuncio)}
        </a>
      </td>
    </tr>
  `).join("");
}

function limparFiltrosFatos() {
  ["fatos-filtro-setor","fatos-filtro-ticker","fatos-filtro-categoria",
   "fatos-filtro-anun-de","fatos-filtro-anun-ate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  aplicarFiltrosFatos();
}

function filtrarAnuncioFatosHoje() {
  const hoje = new Date();
  const iso = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,"0")}-${String(hoje.getDate()).padStart(2,"0")}`;
  const de  = document.getElementById("fatos-filtro-anun-de");
  const ate = document.getElementById("fatos-filtro-anun-ate");
  if (de)  de.value  = iso;
  if (ate) ate.value = iso;
  aplicarFiltrosFatos();
}

function ordenarFatos(campo) {
  if (_ordemFatos.campo === campo) {
    _ordemFatos.direcao = _ordemFatos.direcao === "asc" ? "desc" : "asc";
  } else {
    _ordemFatos.campo = campo;
    _ordemFatos.direcao = _CAMPOS_DESC_DEFAULT.has(campo) ? "desc" : "asc";
  }
  aplicarFiltrosFatos();
}

function ordenarListaFatos(arr) {
  const { campo, direcao } = _ordemFatos;
  const sinal = direcao === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    const va = a[campo]; const vb = b[campo];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sinal;
    return String(va).localeCompare(String(vb), "pt-BR") * sinal;
  });
}

function atualizarIconesSortFatos() {
  document.querySelectorAll('main[data-card="fatos"] th[data-sort]').forEach(th => {
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (th.dataset.sort === _ordemFatos.campo) {
      icon.textContent = _ordemFatos.direcao === "asc" ? "▲" : "▼";
      th.classList.add("sort-ativo");
    } else {
      icon.textContent = "↕";
      th.classList.remove("sort-ativo");
    }
  });
}

async function atualizarNoticiasManual() {
  const btn    = document.getElementById("btn-atualizar-noticias");
  const status = document.getElementById("atualizar-noticias-status");
  if (!btn) return;
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "⏳ Coletando…";
  if (status) status.textContent = "Rodando coletor da fnet (pode levar 10–30s)…";

  try {
    const resp = await fetch("/atualizar-noticias", { method: "POST" });
    const r = await resp.json();
    if (!r.ok) throw new Error(r.erro || "Falha desconhecida");

    // Recarrega o JSON e re-renderiza só os fatos (estamos na tela deles)
    const jsonResp = await fetch("data/noticias.json?v=" + Date.now());
    const data = await jsonResp.json();
    document.getElementById("atualizado-em").textContent = data.atualizado_em || "—";
    renderFatos(data.fatos_relevantes || []);

    const c = r.contagem || {};
    if (status) status.textContent =
      `OK em ${r.duracao_s}s — ${c.dividendos} dividendos · ${c.fatos_relevantes} fatos · ${c.relatorios_gerenciais} relatórios`;
  } catch (e) {
    if (status) status.textContent = "Erro: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

function baixarPlanilhaFatos() {
  if (!_filtradosFatosAtuais.length) {
    alert("Nada para exportar — a lista filtrada está vazia.");
    return;
  }
  const cols = [
    ["Ticker",       a => a.ticker],
    ["Fundo",        a => a.nome_fundo || ""],
    ["Setor",        a => a.setor || ""],
    ["Categoria",    a => a.categoria || ""],
    ["Espécie",      a => a.especie || ""],
    ["Anúncio",      a => (a.data_anuncio || "").replace("T", " ").slice(0, 16)],
    ["URL fnet",     a => a.url_fnet || ""],
  ];
  const escapar = v => {
    const s = String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [
    cols.map(c => c[0]).join(";"),
    ..._filtradosFatosAtuais.map(a => cols.map(c => escapar(c[1](a))).join(";"))
  ];
  const csv = "﻿" + linhas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const hoje = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fatos_relevantes_imobdata_${hoje}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ─── RELATÓRIOS GERENCIAIS: lista filtrável por mês de referência ──────────

let _todosRelatorios = [];
let _filtradosRelatoriosAtuais = [];
let _ordemRelatorios = { campo: "data_anuncio", direcao: "desc" };

// "30/04/2026" ou "04/2026" → "2026-04"; senão null
function refToYM(s) {
  if (!s) return null;
  let m = /^\d{2}\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1]}`;
  m = /^(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1]}`;
  return null;
}

function renderRelatorios(lista) {
  _todosRelatorios = lista.slice();
  popularSelectSetorRelatorios(_todosRelatorios);
  aplicarFiltrosRelatorios();
}

function popularSelectSetorRelatorios(lista) {
  const setores = [...new Set(lista.map(a => a.setor).filter(Boolean))].sort();
  const sel = document.getElementById("rel-filtro-setor");
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos os setores</option>' +
    setores.map(s => `<option value="${s}">${s}</option>`).join("");
}

function aplicarFiltrosRelatorios() {
  const setor   = document.getElementById("rel-filtro-setor")?.value || "";
  const tickerQ = (document.getElementById("rel-filtro-ticker")?.value || "").trim().toUpperCase();
  const mesDe   = document.getElementById("rel-filtro-mes-de")?.value  || "";
  const mesAte  = document.getElementById("rel-filtro-mes-ate")?.value || "";
  const anunDe  = document.getElementById("rel-filtro-anun-de")?.value  || "";
  const anunAte = document.getElementById("rel-filtro-anun-ate")?.value || "";

  const filtrados = _todosRelatorios.filter(a => {
    if (setor && a.setor !== setor) return false;
    if (tickerQ && !a.ticker.toUpperCase().includes(tickerQ)) return false;
    const ym = refToYM(a.data_referencia);
    if (mesDe  && (!ym || ym < mesDe))  return false;
    if (mesAte && (!ym || ym > mesAte)) return false;
    const anuncDate = (a.data_anuncio || "").slice(0, 10);
    if (anunDe  && anuncDate < anunDe)  return false;
    if (anunAte && anuncDate > anunAte) return false;
    return true;
  });

  ordenarListaRelatorios(filtrados);
  atualizarIconesSortRelatorios();
  _filtradosRelatoriosAtuais = filtrados;

  document.getElementById("relatorios-count").textContent =
    `${filtrados.length} de ${_todosRelatorios.length} doc${_todosRelatorios.length !== 1 ? "s" : ""}`;

  const tbody = document.getElementById("tabela-relatorios-body");
  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="sim-vazio-msg">Nenhum resultado para os filtros aplicados.</td></tr>';
    return;
  }
  tbody.innerHTML = filtrados.map(a => `
    <tr>
      <td><a href="fii.html?ticker=${a.ticker}" class="ticker-cell">${a.ticker}</a></td>
      <td class="noticias-nome" title="${a.nome_fundo || ""}">${a.nome_fundo || "—"}</td>
      <td>${a.setor || "—"}</td>
      <td class="num">${formatarMesRef(a.data_referencia)}</td>
      <td class="num">
        <a href="${a.url_fnet}" target="_blank" rel="noopener" class="noticias-link">
          ${formatarDataHora(a.data_anuncio)}
        </a>
      </td>
    </tr>
  `).join("");
}

function limparFiltrosRelatorios() {
  ["rel-filtro-setor","rel-filtro-ticker",
   "rel-filtro-mes-de","rel-filtro-mes-ate",
   "rel-filtro-anun-de","rel-filtro-anun-ate"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  aplicarFiltrosRelatorios();
}

function filtrarAnuncioRelatoriosHoje() {
  const hoje = new Date();
  const iso = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,"0")}-${String(hoje.getDate()).padStart(2,"0")}`;
  const de  = document.getElementById("rel-filtro-anun-de");
  const ate = document.getElementById("rel-filtro-anun-ate");
  if (de)  de.value  = iso;
  if (ate) ate.value = iso;
  aplicarFiltrosRelatorios();
}

function ordenarRelatorios(campo) {
  if (_ordemRelatorios.campo === campo) {
    _ordemRelatorios.direcao = _ordemRelatorios.direcao === "asc" ? "desc" : "asc";
  } else {
    _ordemRelatorios.campo = campo;
    _ordemRelatorios.direcao = _CAMPOS_DESC_DEFAULT.has(campo) || campo === "data_referencia" ? "desc" : "asc";
  }
  aplicarFiltrosRelatorios();
}

function ordenarListaRelatorios(arr) {
  const { campo, direcao } = _ordemRelatorios;
  const sinal = direcao === "asc" ? 1 : -1;
  arr.sort((a, b) => {
    const va = campo === "data_referencia" ? refToYM(a[campo]) : a[campo];
    const vb = campo === "data_referencia" ? refToYM(b[campo]) : b[campo];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * sinal;
    return String(va).localeCompare(String(vb), "pt-BR") * sinal;
  });
}

function atualizarIconesSortRelatorios() {
  document.querySelectorAll('main[data-card="relatorios"] th[data-sort]').forEach(th => {
    const icon = th.querySelector(".sort-icon");
    if (!icon) return;
    if (th.dataset.sort === _ordemRelatorios.campo) {
      icon.textContent = _ordemRelatorios.direcao === "asc" ? "▲" : "▼";
      th.classList.add("sort-ativo");
    } else {
      icon.textContent = "↕";
      th.classList.remove("sort-ativo");
    }
  });
}

function baixarPlanilhaRelatorios() {
  if (!_filtradosRelatoriosAtuais.length) {
    alert("Nada para exportar — a lista filtrada está vazia.");
    return;
  }
  const cols = [
    ["Ticker",            a => a.ticker],
    ["Fundo",             a => a.nome_fundo || ""],
    ["Setor",             a => a.setor || ""],
    ["Mês de referência", a => a.data_referencia || ""],
    ["Anúncio",           a => (a.data_anuncio || "").replace("T", " ").slice(0, 16)],
    ["URL fnet",          a => a.url_fnet || ""],
  ];
  const escapar = v => {
    const s = String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [
    cols.map(c => c[0]).join(";"),
    ..._filtradosRelatoriosAtuais.map(a => cols.map(c => escapar(c[1](a))).join(";"))
  ];
  const csv = "﻿" + linhas.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const hoje = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `relatorios_gerenciais_imobdata_${hoje}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function badgeClasse(cat) {
  if (cat === "Fato Relevante") return "noticias-badge-fato";
  if (cat === "Comunicado ao Mercado") return "noticias-badge-comun";
  return "";
}

function formatarValor(v) {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", {
    style: "currency", currency: "BRL",
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

function formatarVariacao(pct, anterior) {
  if (pct == null || !isFinite(pct)) return "—";
  const sinal = pct >= 0 ? "+" : "";
  const cls   = pct >= 0 ? "var-pos" : "var-neg";
  const tip   = anterior != null
    ? `Anterior: ${anterior.toLocaleString("pt-BR",{style:"currency",currency:"BRL"})}`
    : "";
  return `<span class="${cls}" title="${tip}">${sinal}${(pct*100).toFixed(1)}%</span>`;
}

function formatarData(iso) {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

function formatarDataHora(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt)) return iso;
  return dt.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

// "30/04/2026" → "Abr/26", "04/2026" → "Abr/26", senão devolve cru
function formatarMesRef(s) {
  if (!s) return "—";
  const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  let m = /^\d{2}\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${meses[parseInt(m[1],10)-1]}/${m[2].slice(2)}`;
  m = /^(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${meses[parseInt(m[1],10)-1]}/${m[2].slice(2)}`;
  return s;
}

carregarDados();
