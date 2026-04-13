let todosFiis = [];
let colunaOrdem = null;
let ordemAsc = true;

const COLUNAS_NUMERICAS = ["Preço Atual", "Variação Dia", "P/VP", "DY a.a.", "Retorno - MTD", "Retorno - 12M", "Último Dividendo Pago"];
const PRICES_URL = "https://raw.githubusercontent.com/brunoburthf/imobdatafii/master/prices.json?t=" + Math.floor(Date.now() / 60000);

async function carregarDados() {
  try {
    const [respIndex, respPrecos] = await Promise.all([
      fetch("data/index.json"),
      fetch(PRICES_URL).catch(() => null)
    ]);

    if (!respIndex.ok) throw new Error("Arquivo de dados não encontrado. Rode o script de atualização primeiro.");
    const data = await respIndex.json();

    todosFiis = data.fiis || [];

    // Sobrescreve preço e variação com dados em tempo real do GitHub
    if (respPrecos && respPrecos.ok) {
      const precos = await respPrecos.json();
      todosFiis.forEach(fii => {
        const ticker = fii["Ticker"];
        if (precos.precos?.[ticker] != null) fii["Preço Atual"] = precos.precos[ticker];
        if (precos.variacoes?.[ticker] != null) fii["Variação Dia"] = precos.variacoes[ticker];
      });
    }

    if (data.atualizado_em) {
      document.getElementById("ultima-atualizacao").textContent = "Atualizado em " + data.atualizado_em;
    }

    popularFiltroSetor();
    renderizarTabela(todosFiis);

    document.getElementById("loading").style.display = "none";
    document.getElementById("tabela-wrapper").style.display = "block";
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

function popularFiltroSetor() {
  const setores = [...new Set(todosFiis.map(f => f["Setor"]).filter(Boolean))].sort();
  const sel = document.getElementById("filtro-setor");
  setores.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
}

function filtrarTabela() {
  const busca = document.getElementById("busca").value.toLowerCase();
  const setor = document.getElementById("filtro-setor").value;

  let lista = todosFiis.filter(f => {
    const matchBusca = !busca ||
      (f["Ticker"] || "").toLowerCase().includes(busca) ||
      (f["Nome"] || "").toLowerCase().includes(busca);
    const matchSetor = !setor || f["Setor"] === setor;
    return matchBusca && matchSetor;
  });

  if (colunaOrdem) lista = ordenarLista(lista, colunaOrdem);
  renderizarTabela(lista);
}

function ordenar(coluna) {
  if (colunaOrdem === coluna) {
    ordemAsc = !ordemAsc;
  } else {
    colunaOrdem = coluna;
    ordemAsc = true;
  }
  filtrarTabela();
}

function ordenarLista(lista, coluna) {
  return [...lista].sort((a, b) => {
    let va = a[coluna], vb = b[coluna];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") {
      return ordemAsc ? va - vb : vb - va;
    }
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

  if (coluna === "Preço Atual") return "R$ " + num.toFixed(2);
  if (coluna === "P/VP") return num.toFixed(2) + "x";
  if (coluna === "Variação Dia") {
    const sinal = num >= 0 ? "+" : "";
    return sinal + num.toFixed(2) + "%";
  }
  if (coluna === "DY a.a." || coluna === "Retorno - MTD" || coluna === "Retorno - 12M") {
    return (num * 100).toFixed(2) + "%";
  }
  if (coluna === "Último Dividendo Pago") return "R$ " + num.toFixed(2);
  return num.toFixed(2);
}

function classeValor(coluna, valor) {
  if (!["Retorno - MTD", "Retorno - 12M", "Variação Dia"].includes(coluna)) return "";
  const num = parseFloat(valor);
  if (isNaN(num)) return "";
  return num >= 0 ? "positivo" : "negativo";
}

function renderizarTabela(lista) {
  const tbody = document.getElementById("tabela-body");
  tbody.innerHTML = "";

  const colunas = [
    "Ticker", "Setor",
    "Preço Atual", "Variação Dia", "P/VP", "DY a.a.",
    "Retorno - MTD", "Retorno - 12M", "Último Dividendo Pago"
  ];

  lista.forEach(fii => {
    const tr = document.createElement("tr");
    tr.onclick = () => {
      window.location.href = "fii.html?ticker=" + encodeURIComponent(fii["Ticker"]);
    };

    colunas.forEach((col, i) => {
      const td = document.createElement("td");
      const val = fii[col];
      const isNum = COLUNAS_NUMERICAS.includes(col);

      if (col === "Ticker") {
        td.className = "ticker-cell";
      } else if (isNum) {
        td.className = "num " + classeValor(col, val);
      }

      td.textContent = formatarValor(col, val);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  document.getElementById("contagem-fiis").textContent = lista.length + " FIIs exibidos";
}

// Modal de atualização
function atualizarDados() {
  document.getElementById("modal-atualizar").style.display = "flex";
  document.getElementById("modal-status").textContent = "";
  document.getElementById("btn-confirmar").disabled = false;
}

function fecharModal() {
  document.getElementById("modal-atualizar").style.display = "none";
}

async function confirmarAtualizacao() {
  const btn = document.getElementById("btn-confirmar");
  const status = document.getElementById("modal-status");
  btn.disabled = true;
  status.textContent = "Rodando script... aguarde.";

  try {
    const resp = await fetch("http://localhost:8080/atualizar", { method: "POST" });
    const data = await resp.json();
    if (data.ok) {
      status.textContent = "Dados atualizados com sucesso!";
      setTimeout(() => {
        fecharModal();
        location.reload();
      }, 1500);
    } else {
      status.textContent = "Erro: " + (data.erro || "desconhecido");
      btn.disabled = false;
    }
  } catch (e) {
    status.textContent = "Não foi possível conectar ao servidor local. Certifique-se de que o servidor está rodando.";
    btn.disabled = false;
  }
}

// Esconde botão de atualizar para quem não está em localhost
if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  const btn = document.getElementById("btn-atualizar");
  if (btn) btn.style.display = "none";
}

carregarDados();
