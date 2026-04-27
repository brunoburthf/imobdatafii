/* imoveis.js — Busca e exploração de imóveis */

let todosImoveis = [];  // [{chave, nome, endereco, fundo, area, vacancia, n_donos, desde, historico}]
let colunaOrdem = "nome";
let ordemAsc = true;

async function carregarDados() {
  try {
    const resp = await fetch("data/imoveis_db.json?v=" + Date.now());
    if (!resp.ok) throw new Error("imoveis_db.json não encontrado. Rode atualizar_imoveis_db.py.");
    const db = await resp.json();

    // Transforma o mapa em lista flat
    for (const [chave, dados] of Object.entries(db.imoveis || {})) {
      const hist = dados.historico || [];
      if (!hist.length) continue;
      const ultimo = hist[hist.length - 1];
      const fundosUnicos = [...new Set(hist.map(h => h.fundo))];
      todosImoveis.push({
        chave,
        nome: dados.nome || "",
        endereco: dados.endereco_original || "",
        fundo: ultimo.fundo,
        area: ultimo.area,
        vacancia: ultimo.vacancia,
        n_donos: fundosUnicos.length,
        desde: hist[0].data_ref,
        historico: hist,
        fundos_todos: fundosUnicos
      });
    }

    // Popula filtro de fundos
    const fundos = [...new Set(todosImoveis.map(i => i.fundo))].sort();
    const sel = document.getElementById("filtro-fundo");
    fundos.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f; opt.textContent = f;
      sel.appendChild(opt);
    });

    // Stats
    document.getElementById("stats").style.display = "flex";
    document.getElementById("stats").innerHTML = `
      <div class="imoveis-stat-card">
        <div class="imoveis-stat-valor">${db.total_imoveis?.toLocaleString("pt-BR") || todosImoveis.length}</div>
        <div class="imoveis-stat-label">Imóveis únicos</div>
      </div>
      <div class="imoveis-stat-card">
        <div class="imoveis-stat-valor">${db.total_registros?.toLocaleString("pt-BR") || "—"}</div>
        <div class="imoveis-stat-label">Registros históricos</div>
      </div>
      <div class="imoveis-stat-card">
        <div class="imoveis-stat-valor">${fundos.length}</div>
        <div class="imoveis-stat-label">Fundos distintos</div>
      </div>
      <div class="imoveis-stat-card">
        <div class="imoveis-stat-valor">${todosImoveis.filter(i => i.n_donos > 1).length}</div>
        <div class="imoveis-stat-label">Múltiplos donos</div>
      </div>
    `;

    document.getElementById("loading").style.display = "none";
    document.getElementById("tabela-wrapper").style.display = "block";
    renderizarTabela(todosImoveis);
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    document.getElementById("erro").style.display = "block";
    document.getElementById("erro").textContent = e.message;
  }
}

function filtrarImoveis() {
  const q = document.getElementById("busca").value.toLowerCase();
  const fundo = document.getElementById("filtro-fundo").value;

  let lista = todosImoveis.filter(i => {
    const matchBusca = !q ||
      i.nome.toLowerCase().includes(q) ||
      i.endereco.toLowerCase().includes(q) ||
      i.fundo.toLowerCase().includes(q) ||
      i.fundos_todos.some(f => f.toLowerCase().includes(q));
    const matchFundo = !fundo || i.fundo === fundo || i.fundos_todos.includes(fundo);
    return matchBusca && matchFundo;
  });

  lista = ordenarLista(lista);
  renderizarTabela(lista);
}

function ordenar(col) {
  if (colunaOrdem === col) ordemAsc = !ordemAsc;
  else { colunaOrdem = col; ordemAsc = col === "nome" || col === "endereco" || col === "fundo"; }
  filtrarImoveis();
}

function ordenarLista(lista) {
  return [...lista].sort((a, b) => {
    let va = a[colunaOrdem], vb = b[colunaOrdem];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return ordemAsc ? va - vb : vb - va;
    return ordemAsc
      ? String(va).localeCompare(String(vb), "pt-BR")
      : String(vb).localeCompare(String(va), "pt-BR");
  });
}

function fmtData(s) {
  if (!s) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
}

function renderizarTabela(lista) {
  const tbody = document.getElementById("tabela-body");
  tbody.innerHTML = "";

  lista.forEach(i => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.onclick = () => abrirDetalhe(i.chave);

    const vacTxt = i.vacancia != null ? (i.vacancia * 100).toFixed(1) + "%" : "—";
    const vacCls = i.vacancia != null ? (i.vacancia > 0.1 ? "negativo" : "positivo") : "";
    const donosCls = i.n_donos > 1 ? "style='color:var(--azul);font-weight:700'" : "";

    tr.innerHTML = `
      <td style="font-weight:600">${i.nome || "—"}</td>
      <td style="max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${i.endereco}">${i.endereco || "—"}</td>
      <td class="ticker-cell">${i.fundo}</td>
      <td class="num">${i.area != null ? i.area.toLocaleString("pt-BR") : "—"}</td>
      <td class="num ${vacCls}">${vacTxt}</td>
      <td class="num" ${donosCls}>${i.n_donos}</td>
      <td class="num">${fmtData(i.desde)}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("contagem").textContent = lista.length + " imóveis exibidos";
}

function abrirDetalhe(chave) {
  const i = todosImoveis.find(x => x.chave === chave);
  if (!i) return;

  document.getElementById("tabela-wrapper").style.display = "none";
  document.getElementById("stats").style.display = "none";
  document.querySelector(".toolbar").style.display = "none";
  document.getElementById("imovel-detalhe").style.display = "block";

  document.getElementById("detalhe-nome").textContent = i.nome || "Sem nome";
  document.getElementById("detalhe-endereco").textContent = i.endereco;

  const tbody = document.getElementById("detalhe-tbody");
  tbody.innerHTML = "";

  // Agrupa por fundo para destacar mudanças
  let fundoAnterior = "";
  i.historico.forEach(h => {
    const mudou = h.fundo !== fundoAnterior && fundoAnterior !== "";
    fundoAnterior = h.fundo;
    const tr = document.createElement("tr");
    if (mudou) tr.style.borderTop = "3px solid var(--azul)";
    tr.style.borderBottom = "1px solid #f0f2f5";

    const vacTxt = h.vacancia != null ? (h.vacancia * 100).toFixed(1) + "%" : "—";
    const pctTxt = h.pct_total != null ? (h.pct_total * 100).toFixed(1) + "%" : "—";

    tr.innerHTML = `
      <td style="padding:6px 8px">${fmtData(h.data_ref)}</td>
      <td style="padding:6px 8px;font-weight:700;color:var(--navy)">${h.fundo}</td>
      <td style="padding:6px 8px;text-align:right">${h.area != null ? h.area.toLocaleString("pt-BR") : "—"}</td>
      <td style="padding:6px 8px;text-align:right">${vacTxt}</td>
      <td style="padding:6px 8px;text-align:right">${pctTxt}</td>
    `;
    tbody.appendChild(tr);
  });
}

function fecharDetalhe() {
  document.getElementById("imovel-detalhe").style.display = "none";
  document.querySelector(".toolbar").style.display = "flex";
  document.getElementById("stats").style.display = "flex";
  document.getElementById("tabela-wrapper").style.display = "block";
}

carregarDados();
