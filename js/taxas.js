// Lista de taxas de administração e performance dos fundos cobertos.
// Le data/taxas.json (gerado por scripts/atualizar_taxas.py) e cruza com
// data/index.json / agro_index.json / infra_index.json pra obter Nome e Setor.

let _todasTaxas = [];   // [{ticker, nome, setor, adm_pct, adm_tipo, adm_obs, perf, perf_pct, perf_bench, perf_txt, conf}]
let _ordem = { campo: "adm_pct", direcao: "desc" };

async function carregar() {
  try {
    const [rTaxas, rFii, rAgro, rInfra] = await Promise.all([
      fetch("data/taxas.json"),
      fetch("data/index.json"),
      fetch("data/agro_index.json").catch(() => null),
      fetch("data/infra_index.json").catch(() => null),
    ]);
    if (!rTaxas.ok) throw new Error("data/taxas.json não encontrado");
    if (!rFii.ok)   throw new Error("data/index.json não encontrado");

    const docTaxas = await rTaxas.json();
    const docFii   = await rFii.json();
    const docAgro  = (rAgro  && rAgro.ok)  ? await rAgro.json()  : { fundos: [] };
    const docInfra = (rInfra && rInfra.ok) ? await rInfra.json() : { fundos: [] };

    // Mapa ticker -> {Nome, Setor}
    const mapaInfo = {};
    for (const f of docFii.fiis || [])       mapaInfo[f.Ticker] = { nome: f.Nome,  setor: f.Setor || "" };
    for (const f of docAgro.fundos  || [])   mapaInfo[f.Ticker] = { nome: f.Nome || f.Ticker, setor: f.Setor || "FI-Agro" };
    for (const f of docInfra.fundos || [])   mapaInfo[f.Ticker] = { nome: f.Nome || f.Ticker, setor: f.Setor || "FI-Infra" };

    // Achata
    _todasTaxas = [];
    for (const [tk, t] of Object.entries(docTaxas.taxas || {})) {
      const info = mapaInfo[tk] || { nome: tk, setor: "—" };
      _todasTaxas.push({
        ticker:     tk,
        nome:       info.nome,
        setor:      info.setor,
        adm_pct:    t.adm_pct,
        adm_tipo:   t.adm_tipo || "—",
        adm_obs:    t.adm_obs,
        perf:       t.perf,         // true / false / null
        perf_pct:   t.perf_pct,
        perf_bench: t.perf_bench,
        perf_txt:   t.perf_txt,
        conf:       t.conf,         // alta / media / baixa / manual
        rg_omisso:  t.rg_omisso === true, // RG nao traz a taxa; valor de fonte secundaria
      });
    }

    document.getElementById("taxas-atualizado").textContent =
      (docTaxas.atualizado_em || "").replace("T", " ").slice(0, 16);

    // Setores no filtro
    const setores = [...new Set(_todasTaxas.map(x => x.setor).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    const sel = document.getElementById("filtro-setor");
    sel.innerHTML = '<option value="">Todos os setores</option>' +
      setores.map(s => `<option value="${s}">${escapeHtml(s)}</option>`).join("");

    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";
    aplicarFiltrosTaxas();
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function aplicarFiltrosTaxas() {
  const setor    = document.getElementById("filtro-setor").value;
  const ticker   = (document.getElementById("filtro-ticker").value || "").toUpperCase().trim();
  const filPerf  = document.getElementById("filtro-perf").value;
  const filConf  = document.getElementById("filtro-conf").value;

  const f = _todasTaxas.filter(t => {
    if (setor && t.setor !== setor) return false;
    if (ticker && !(t.ticker || "").includes(ticker)) return false;
    if (filPerf === "sim" && t.perf !== true)  return false;
    if (filPerf === "nao" && t.perf !== false) return false;
    if (filPerf === "indef" && (t.perf === true || t.perf === false)) return false;
    if (filConf && t.conf !== filConf) return false;
    return true;
  });

  document.getElementById("taxas-count").textContent =
    `${f.length} de ${_todasTaxas.length} fundo${_todasTaxas.length !== 1 ? "s" : ""}`;

  _renderTabela(_ordenar(f));
  _atualizarIconesOrdem();
}

function _ordenar(lista) {
  const { campo, direcao } = _ordem;
  const mult = direcao === "asc" ? 1 : -1;
  return [...lista].sort((a, b) => {
    let va = a[campo], vb = b[campo];
    // null/undefined vão pro fim
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    // perf: true > false > null. Mas null já foi tratado acima
    if (campo === "perf") { va = va ? 1 : 0; vb = vb ? 1 : 0; }
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return -1 * mult;
    if (va > vb) return  1 * mult;
    return 0;
  });
}

function ordenarTaxas(campo) {
  if (_ordem.campo === campo) {
    _ordem.direcao = _ordem.direcao === "asc" ? "desc" : "asc";
  } else {
    _ordem.campo = campo;
    _ordem.direcao = "asc";
  }
  aplicarFiltrosTaxas();
}

function _atualizarIconesOrdem() {
  document.querySelectorAll("#tabela-taxas th[data-sort]").forEach(th => {
    const ic = th.querySelector(".sort-icon");
    if (!ic) return;
    ic.textContent = (th.dataset.sort === _ordem.campo)
      ? (_ordem.direcao === "asc" ? "↑" : "↓")
      : "↕";
  });
}

function _renderTabela(lista) {
  const tbody = document.getElementById("tabela-taxas-body");
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="sim-vazio-msg">Nenhum fundo no filtro.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(t => {
    const admValor = t.adm_pct != null
      ? t.adm_pct.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : null;
    const admCell = admValor != null
      ? (t.rg_omisso
          ? `${admValor}<span class="rg-omisso" title="RG nao traz a taxa; valor obtido de fonte secundaria (Informe Anual/Regulamento)">*</span>`
          : admValor)
      : `<span class="sem-doc">—</span>`;
    let perfCell, perfDet;
    if (t.perf === true) {
      perfCell = `<span class="age-aprov age-aprov-aprovada">✓ Sim</span>`;
      let det = "";
      if (t.perf_pct != null) det += t.perf_pct + "%";
      if (t.perf_bench)       det += (det ? " sobre " : "") + t.perf_bench;
      perfDet = det || (t.perf_txt ? truncarT(t.perf_txt, 60) : "—");
      if (t.perf_txt) perfDet = `<span title="${escapeHtml(t.perf_txt)}">${escapeHtml(perfDet)}</span>`;
    } else if (t.perf === false) {
      perfCell = `<span class="age-aprov age-aprov-prejudicada">— Não</span>`;
      perfDet  = "—";
    } else {
      perfCell = `<span class="age-aprov age-aprov-adiada">? Indef.</span>`;
      perfDet  = "—";
    }
    const confBadge = t.conf
      ? `<span class="taxas-conf-badge conf-${t.conf}">${t.conf}</span>`
      : "—";
    return `<tr>
      <td><a href="fii.html?ticker=${t.ticker}" class="ticker-link">${t.ticker}</a></td>
      <td title="${escapeHtml(t.nome || '')}">${escapeHtml(truncarT(t.nome, 38))}</td>
      <td>${escapeHtml(t.setor || "—")}</td>
      <td class="num">${admCell}</td>
      <td>${escapeHtml(t.adm_tipo || "—")}</td>
      <td>${perfCell}</td>
      <td>${perfDet}</td>
      <td>${confBadge}</td>
    </tr>`;
  }).join("");
}

function limparFiltrosTaxas() {
  document.getElementById("filtro-setor").value = "";
  document.getElementById("filtro-ticker").value = "";
  document.getElementById("filtro-perf").value = "";
  document.getElementById("filtro-conf").value = "";
  aplicarFiltrosTaxas();
}

function truncarT(s, n) {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : (s || "");
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

carregar();
