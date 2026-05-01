const MAX_FUNDOS = 15;

let todosFiis = [];
let carteira  = []; // [{ticker, nome, setor}]
let sugestaoIdx = -1;
let vazioEl = null;
let vazioAcompEl = null;
window.carteiraAtualId = null;
window.modoSimulador = "simulacao"; // "simulacao" | "acompanhamento"

// ─── NAVEGAÇÃO DE TELAS ─────────────────────────────────────────────────────

function mostrarTela(id) {
  ["tela-login", "tela-escolha", "tela-carteiras", "tela-simulador"].forEach(t => {
    const el = document.getElementById(t);
    if (el) el.style.display = t === id ? "" : "none";
  });
}

function voltarEscolha() {
  // tela-escolha (cards "Minhas Carteiras"/"Criar Nova") só faz sentido com
  // usuário logado. Deslogado, o "Voltar" sai do simulador (volta para a
  // página anterior — index, fiis, etc — de onde o usuário veio).
  if (!window.currentUser) {
    history.back();
    return;
  }
  mostrarTela("tela-escolha");
  atualizarContadorEscolha();
}

function mostrarCriarNova() {
  window.carteiraAtualId = null;
  // Limpa IDs e estado de carteiras anteriores no localStorage para evitar
  // que um redirect "leve junto" o ID de outra carteira.
  localStorage.removeItem("sim_carteira_id");
  localStorage.removeItem("acomp_carteira_id");
  localStorage.removeItem("acomp_transacoes");
  localStorage.removeItem("acomp_posicoes");
  localStorage.removeItem("sim_pesos");
  localStorage.removeItem("sim_valor_total");
  carteira = [];
  const nomeInput = document.getElementById("carteira-nome");
  if (nomeInput) nomeInput.value = "";
  const valorInput = document.getElementById("sim-valor-total");
  if (valorInput) valorInput.value = "";
  setModo("simulacao", false);
  renderizarTabela();
  renderizarAcompTabela();
  mostrarTela("tela-simulador");
}

// ─── MODO SIMULAÇÃO / ACOMPANHAMENTO ────────────────────────────────────────

function setModo(novo, bloquear = null) {
  if (novo !== "simulacao" && novo !== "acompanhamento") return;
  window.modoSimulador = novo;
  const tela = document.getElementById("tela-simulador");
  if (tela) tela.dataset.modo = novo;
  document.querySelectorAll(".modo-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.modo === novo);
  });
  if (bloquear !== null) {
    const tabs = document.querySelector(".modo-tabs");
    if (tabs) tabs.dataset.bloqueado = bloquear ? "true" : "false";
  }
  // Atualiza totais e botões de acordo com o modo
  if (novo === "simulacao") {
    atualizarTotal();
  } else {
    atualizarCustoAcomp();
  }
  // Esconde sugestões abertas
  const sug = document.getElementById("sim-sugestoes");
  if (sug) sug.style.display = "none";
}

function renderListaCarteiras(lista) {
  const container = document.getElementById("lista-carteiras");
  if (!container) return;
  if (!lista.length) {
    container.innerHTML = '<p class="lista-vazia">Nenhuma carteira salva ainda.</p>';
    return;
  }
  container.innerHTML = lista.map(c => {
    const dt = c.updated_at?.toDate?.()
      ? c.updated_at.toDate().toLocaleDateString("pt-BR")
      : "";
    const fundos = (c.carteira || []).length;
    const tipo = c.tipo || "simulacao";
    const tipoLabel = tipo === "acompanhamento" ? "Acompanhamento" : "Simulação";
    let resumo = "";
    if (tipo === "acompanhamento" && c.posicoes) {
      const custoTotal = Object.values(c.posicoes).reduce((s, p) => s + (p.preco_medio || 0) * (p.quantidade || 0), 0);
      if (custoTotal > 0) resumo = custoTotal.toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
    } else if (c.valor_total > 0) {
      resumo = c.valor_total.toLocaleString("pt-BR", {style:"currency", currency:"BRL"});
    }
    return `
      <div class="carteira-item">
        <div class="carteira-item-info">
          <div class="carteira-item-nome">
            <span class="carteira-tipo-badge carteira-tipo-${tipo}">${tipoLabel}</span>
            ${c.name || "Sem nome"}
          </div>
          <div class="carteira-item-meta">
            ${fundos} fundo${fundos !== 1 ? "s" : ""}${resumo ? " · " + resumo : ""}${dt ? " · " + dt : ""}
          </div>
        </div>
        <div class="carteira-item-acoes">
          <button class="carteiras-btn btn-carregar" onclick="abrirCarteira('${c.id}')">Abrir</button>
          <button class="carteiras-btn btn-deletar" onclick="excluirCarteira('${c.id}')">Excluir</button>
        </div>
      </div>
    `;
  }).join("");
}

async function mostrarMinhasCarteiras() {
  mostrarTela("tela-carteiras");
  const container = document.getElementById("lista-carteiras");

  const cached = getCarteirasCache();
  if (cached) {
    renderListaCarteiras(cached);
    return;
  }

  container.innerHTML = '<p style="color:#888">Carregando...</p>';
  try {
    const lista = await listarCarteiras();
    renderListaCarteiras(lista);
  } catch (e) {
    container.innerHTML = '<p style="color:#c00">Erro ao carregar carteiras.</p>';
  }
}

async function abrirCarteira(id) {
  try {
    const data = await carregarCarteiraFirestore(id);
    if (!data) return alert("Carteira não encontrada.");

    const tipoCarteira = data.tipo || "simulacao";

    // Carteira de Simulação sempre abre direto na tela de resultado
    if (tipoCarteira === "simulacao") {
      localStorage.setItem("sim_carteira",      JSON.stringify(data.carteira || []));
      localStorage.setItem("sim_pesos",         JSON.stringify(data.pesos || {}));
      localStorage.setItem("sim_valor_total",   String(data.valor_total || 0));
      localStorage.setItem("sim_nome_carteira", data.name || "");
      localStorage.setItem("sim_carteira_id",   data.id);
      localStorage.setItem("sim_tipo",          "simulacao");
      window.location.href = "resultado.html";
      return;
    }

    // Carteira de Acompanhamento também vai direto pra tela de resultado
    if (tipoCarteira === "acompanhamento") {
      localStorage.setItem("acomp_carteira",      JSON.stringify(data.carteira || []));
      if (Array.isArray(data.transacoes)) {
        // Schema novo
        localStorage.setItem("acomp_transacoes", JSON.stringify(data.transacoes));
        localStorage.removeItem("acomp_posicoes");
      } else {
        // Schema antigo — resultado.html migra para transações no init
        localStorage.setItem("acomp_posicoes", JSON.stringify(data.posicoes || {}));
        localStorage.removeItem("acomp_transacoes");
      }
      localStorage.setItem("acomp_nome_carteira", data.name || "");
      localStorage.setItem("acomp_carteira_id",   data.id);
      localStorage.setItem("sim_tipo",            "acompanhamento");
      window.location.href = "resultado.html";
      return;
    }

    window.carteiraAtualId = data.id;
    carteira = data.carteira || [];

    const nomeInput = document.getElementById("carteira-nome");
    if (nomeInput) nomeInput.value = data.name || "";

    setModo(tipoCarteira, true);
    renderizarTabela();
    renderizarAcompTabela();

    if (tipoCarteira === "acompanhamento") {
      // Restaura posições
      if (data.posicoes) {
        document.querySelectorAll("#acomp-tbody tr[data-ticker]").forEach(tr => {
          const p = data.posicoes[tr.dataset.ticker];
          if (!p) return;
          const pm  = tr.querySelector(".acomp-pm-input");
          const qtd = tr.querySelector(".acomp-qtd-input");
          const dt  = tr.querySelector(".acomp-data-input");
          if (pm  && p.preco_medio != null) pm.value  = p.preco_medio || "";
          if (qtd && p.quantidade  != null) qtd.value = p.quantidade  || "";
          if (dt  && p.data_compra)         dt.value  = p.data_compra;
        });
      }
      atualizarCustoAcomp();
    } else {
      // Restaura pesos
      if (data.pesos) {
        document.querySelectorAll("#sim-tbody tr[data-ticker]").forEach(tr => {
          const inp = tr.querySelector(".sim-peso-input");
          if (inp && data.pesos[tr.dataset.ticker] != null) {
            inp.value = data.pesos[tr.dataset.ticker];
          }
        });
      }
      // Restaura valor
      const valorInp = document.getElementById("sim-valor-total");
      if (valorInp && data.valor_total > 0) {
        valorInp.value = data.valor_total.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      atualizarTotal();
    }

    mostrarTela("tela-simulador");
  } catch (e) {
    alert("Erro ao abrir: " + e.message);
  }
}

async function excluirCarteira(id) {
  if (!confirm("Tem certeza que deseja excluir esta carteira?")) return;
  try {
    await deletarCarteiraFirestore(id);
    if (window.carteiraAtualId === id) window.carteiraAtualId = null;
    mostrarMinhasCarteiras();
  } catch (e) {
    alert("Erro ao excluir: " + e.message);
  }
}

let _salvandoSimulador = false;

async function salvarCarteiraManual() {
  if (_salvandoSimulador) return;
  if (!window.currentUser) { alert("Você precisa estar logado para salvar."); return; }
  if (!carteira.length) { alert("Adicione pelo menos um fundo antes de salvar."); return; }

  const nomeInput = document.getElementById("carteira-nome");
  const nome = (nomeInput?.value || "").trim();
  if (!nome) {
    alert("Dê um nome à sua carteira antes de salvar.");
    nomeInput?.focus();
    return;
  }

  const modo = window.modoSimulador;
  let dados;
  if (modo === "acompanhamento") {
    // Schema novo: cada linha preenchida vira UMA transação inicial de compra.
    // (Espelha criarCarteiraAcomp — assim o dado salvo via "Salvar carteira" não
    // diverge do salvo via "Criar Carteira", e resultado.js lê sem migração.)
    const transacoes = [];
    document.querySelectorAll("#acomp-tbody tr[data-ticker]").forEach(tr => {
      const qtd   = parseFloat(tr.querySelector(".acomp-qtd-input")?.value) || 0;
      const preco = parseFloat(tr.querySelector(".acomp-pm-input")?.value)  || 0;
      const data  = tr.querySelector(".acomp-data-input")?.value || "";
      if (qtd > 0 && preco > 0 && data) {
        transacoes.push({ ticker: tr.dataset.ticker, tipo: "compra", qtd, preco, data });
      }
    });
    const v = await _validarLinhasAcomp(transacoes);
    if (v.erro)      { alert(v.erro); return; }
    if (v.cancelado) return;
    dados = {
      name:       nome,
      tipo:       "acompanhamento",
      carteira:   carteira,
      transacoes: transacoes,
    };
  } else {
    const pesos = {};
    document.querySelectorAll("#sim-tbody tr[data-ticker]").forEach(tr => {
      const inp = tr.querySelector(".sim-peso-input");
      if (inp) pesos[tr.dataset.ticker] = parseFloat(inp.value) || 0;
    });
    const valorTotal = parseValorCarteira(document.getElementById("sim-valor-total")?.value);
    dados = {
      name:        nome,
      tipo:        "simulacao",
      carteira:    carteira,
      pesos:       pesos,
      valor_total: valorTotal,
    };
  }

  const status = document.getElementById("sim-salvar-status");

  // Otimista: mostra "Carteira salva!" imediatamente
  if (status) {
    status.textContent = "Carteira salva!";
    status.className = "sim-salvar-status sim-salvar-ok";
    setTimeout(() => {
      if (status.textContent === "Carteira salva!") {
        status.textContent = "";
        status.className = "sim-salvar-status";
      }
    }, 3000);
  }

  _salvandoSimulador = true;
  try {
    const id = await salvarCarteiraFirestore(window.carteiraAtualId || null, dados);
    window.carteiraAtualId = id;
  } catch (e) {
    const isLimit = e?.code === "limit-exceeded";
    if (status) {
      status.textContent = isLimit ? "Limite atingido." : "Erro ao salvar.";
      status.className = "sim-salvar-status sim-salvar-erro";
    }
    alert(isLimit ? e.message : "Erro ao salvar: " + e.message);
  } finally {
    _salvandoSimulador = false;
  }
}

async function atualizarContadorEscolha() {
  const el = document.getElementById("escolha-count");
  if (!el || !window.currentUser) return;
  try {
    const lista = await listarCarteiras();
    el.textContent = lista.length + " carteira" + (lista.length !== 1 ? "s" : "") + " salva" + (lista.length !== 1 ? "s" : "");
  } catch {
    el.textContent = "";
  }
}

// ─── AUTH STATE → TELAS ─────────────────────────────────────────────────────

// Parâmetros de URL — ?action=login | ?action=carteiras | ?return=URL
const _urlParams  = new URLSearchParams(window.location.search);
const _actionURL  = _urlParams.get("action");
const _returnURL  = _urlParams.get("return");

document.addEventListener("auth-state-changed", () => {
  const headerUser    = document.getElementById("auth-header-user");
  const headerLogin   = document.getElementById("auth-header-login");
  const headerLoginMsg = document.getElementById("auth-header-login-msg");

  if (window.currentUser) {
    const email = window.currentUser.email || "";
    const nome = email.split("@")[0];
    if (headerUser) {
      headerUser.style.display = "";
      headerUser.innerHTML = `
        <button class="auth-btn auth-btn-carteiras" onclick="mostrarMinhasCarteiras()">Minhas Carteiras</button>
        <span class="auth-user-email">${nome}</span>
        <button class="auth-btn auth-btn-logout" onclick="logout()">Sair</button>`;
    }
    if (headerLogin)    headerLogin.style.display    = "none";
    if (headerLoginMsg) headerLoginMsg.style.display = "none";

    // Se veio de outra página com ?return=, volta pra ela após login
    if (_returnURL) {
      window.location.href = _returnURL;
      return;
    }

    // Se estava na tela de login (acabou de logar), vai pra escolha
    const telaLogin = document.getElementById("tela-login");
    if (telaLogin && telaLogin.style.display !== "none") {
      mostrarTela("tela-escolha");
      atualizarContadorEscolha();
    }
  } else {
    if (headerUser) {
      headerUser.style.display = "none";
      headerUser.innerHTML = "";
    }
    if (headerLogin)    headerLogin.style.display    = "";
    if (headerLoginMsg) headerLoginMsg.style.display = "";
    // Se o usuário fez logout estando em tela-escolha/carteiras (que só fazem
    // sentido logado), tira ele dessas telas e leva pra criação livre.
    const telaEscolha   = document.getElementById("tela-escolha");
    const telaCarteiras = document.getElementById("tela-carteiras");
    const visivel = el => el && el.style.display !== "none";
    if (visivel(telaEscolha) || visivel(telaCarteiras)) {
      mostrarCriarNova();
    }
    // Não força tela-login automaticamente — usuário pode estar criando carteira sem conta
  }
});

// ─── CARREGAMENTO ────────────────────────────────────────────────────────────

async function carregarDados() {
  vazioEl = document.getElementById("sim-vazio");
  vazioAcompEl = document.getElementById("acomp-vazio");
  try {
    const [resp, respInfra, respAgro] = await Promise.all([
      fetch("data/index.json"),
      fetch("data/infra_index.json").catch(() => null),
      fetch("data/agro_index.json").catch(() => null)
    ]);
    if (!resp.ok) throw new Error("Dados não encontrados. Rode o script de atualização primeiro.");
    const data = await resp.json();
    todosFiis = data.fiis || [];
    if (respInfra && respInfra.ok) {
      const infra = await respInfra.json();
      todosFiis = todosFiis.concat(infra.fundos || []);
    }
    if (respAgro && respAgro.ok) {
      const agro = await respAgro.json();
      todosFiis = todosFiis.concat(agro.fundos || []);
    }
    document.getElementById("loading").style.display = "none";
    document.getElementById("conteudo").style.display = "block";

    // Tela inicial: depende do parâmetro ?action= e do estado de auth
    if (_actionURL === "login") {
      mostrarTela("tela-login");
    } else if (_actionURL === "carteiras") {
      if (window.currentUser) mostrarMinhasCarteiras();
      else                    mostrarTela("tela-login");
    } else {
      // Padrão: criar nova carteira direto, sem exigir login
      mostrarCriarNova();
    }
  } catch (e) {
    document.getElementById("loading").style.display = "none";
    const el = document.getElementById("erro");
    el.style.display = "block";
    el.textContent = e.message;
  }
}

// ─── BUSCA E SUGESTÕES ──────────────────────────────────────────────────────

function filtrarSugestoes() {
  const q = document.getElementById("sim-busca").value.trim().toUpperCase();
  const box = document.getElementById("sim-sugestoes");
  sugestaoIdx = -1;

  if (!q) { box.style.display = "none"; return; }

  const tickersNaCarteira = new Set(carteira.map(f => f.ticker));
  const resultados = todosFiis
    .filter(f => {
      const t = (f["Ticker"] || "").toUpperCase();
      const n = (f["Nome"]   || "").toUpperCase();
      return (t.includes(q) || n.includes(q)) && !tickersNaCarteira.has(f["Ticker"]);
    })
    .slice(0, 8);

  if (!resultados.length) { box.style.display = "none"; return; }

  box.innerHTML = resultados.map((f, i) =>
    `<div class="sim-sugestao" data-idx="${i}"
      onmousedown="adicionarFii('${f["Ticker"]}')">
      <span class="sim-sug-ticker">${f["Ticker"]}</span>
      <span class="sim-sug-nome">${f["Nome"] || ""}</span>
    </div>`
  ).join("");

  box._resultados = resultados;
  box.style.display = "block";
}

function navegarSugestoes(e) {
  const box   = document.getElementById("sim-sugestoes");
  const items = box.querySelectorAll(".sim-sugestao");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    sugestaoIdx = Math.min(sugestaoIdx + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    sugestaoIdx = Math.max(sugestaoIdx - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const idx = sugestaoIdx >= 0 ? sugestaoIdx : 0;
    const r   = box._resultados?.[idx];
    if (r) adicionarFii(r["Ticker"]);
    return;
  } else if (e.key === "Escape") {
    box.style.display = "none";
    return;
  }

  items.forEach((el, i) => el.classList.toggle("ativo", i === sugestaoIdx));
}

document.addEventListener("click", e => {
  if (!e.target.closest(".sim-busca-container")) {
    document.getElementById("sim-sugestoes").style.display = "none";
  }
});

// ─── GERENCIAR CARTEIRA ─────────────────────────────────────────────────────

function adicionarFii(ticker) {
  if (carteira.length >= MAX_FUNDOS) return;
  if (carteira.find(f => f.ticker === ticker)) return;

  const fii = todosFiis.find(f => f["Ticker"] === ticker);
  if (!fii) return;

  carteira.push({ ticker, nome: fii["Nome"] || "", setor: fii["Setor"] || "" });

  document.getElementById("sim-busca").value = "";
  document.getElementById("sim-sugestoes").style.display = "none";

  renderizarTabela();
  renderizarAcompTabela();
}

function removerFii(ticker) {
  carteira = carteira.filter(f => f.ticker !== ticker);
  renderizarTabela();
  renderizarAcompTabela();
}

// ─── TABELA ─────────────────────────────────────────────────────────────────

function renderizarTabela() {
  const tbody  = document.getElementById("sim-tbody");
  const tfoot  = document.getElementById("sim-tfoot");
  const aviso  = document.getElementById("sim-aviso");
  const vazio  = vazioEl;

  document.getElementById("sim-contador").textContent =
    `${carteira.length} / ${MAX_FUNDOS} fundos`;

  const salvarWrapper = document.getElementById("sim-salvar-wrapper");
  if (salvarWrapper) salvarWrapper.style.display = carteira.length ? "flex" : "none";

  if (!carteira.length) {
    tbody.innerHTML = "";
    tbody.appendChild(vazio);
    vazio.style.display = "";
    tfoot.style.display = "none";
    aviso.style.display = "none";
    return;
  }

  vazio.style.display = "none";
  tfoot.style.display = "";

  const pesosAtuais = {};
  tbody.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const input = tr.querySelector("input");
    if (input) pesosAtuais[tr.dataset.ticker] = input.value;
  });

  tbody.innerHTML = "";

  carteira.forEach(f => {
    const tr = document.createElement("tr");
    tr.dataset.ticker = f.ticker;

    const pesoAtual = pesosAtuais[f.ticker] ?? "";

    tr.innerHTML = `
      <td class="ticker-cell">${f.ticker}</td>
      <td>${f.nome}</td>
      <td>${f.setor || "—"}</td>
      <td class="num">
        <input type="number" class="sim-peso-input" min="0" max="100" step="0.01"
          value="${pesoAtual}" placeholder="0"
          oninput="atualizarTotal()" />
        <span class="sim-peso-pct">%</span>
      </td>
      <td class="num sim-posicao-valor">—</td>
      <td>
        <button class="sim-remover" onclick="removerFii('${f.ticker}')" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  atualizarTotal();
}

function renderizarAcompTabela() {
  const tbody = document.getElementById("acomp-tbody");
  const tfoot = document.getElementById("acomp-tfoot");
  const vazio = vazioAcompEl;
  if (!tbody || !vazio) return;

  if (!carteira.length) {
    tbody.innerHTML = "";
    tbody.appendChild(vazio);
    vazio.style.display = "";
    tfoot.style.display = "none";
    atualizarCustoAcomp();
    return;
  }

  vazio.style.display = "none";
  tfoot.style.display = "";

  // Preserva valores já digitados
  const atuais = {};
  tbody.querySelectorAll("tr[data-ticker]").forEach(tr => {
    atuais[tr.dataset.ticker] = {
      pm:   tr.querySelector(".acomp-pm-input")?.value   ?? "",
      qtd:  tr.querySelector(".acomp-qtd-input")?.value  ?? "",
      data: tr.querySelector(".acomp-data-input")?.value ?? "",
    };
  });

  tbody.innerHTML = "";
  carteira.forEach(f => {
    const d = atuais[f.ticker] || {};
    const tr = document.createElement("tr");
    tr.dataset.ticker = f.ticker;
    tr.innerHTML = `
      <td class="ticker-cell">${f.ticker}</td>
      <td>${f.nome}</td>
      <td>${f.setor || "—"}</td>
      <td class="num">
        <input type="number" class="acomp-pm-input" min="0" step="0.01"
          value="${d.pm}" placeholder="0,00"
          oninput="atualizarCustoAcomp()" />
      </td>
      <td class="num">
        <input type="number" class="acomp-qtd-input" min="0" step="1"
          value="${d.qtd}" placeholder="0"
          oninput="atualizarCustoAcomp()" />
      </td>
      <td class="num">
        <input type="date" class="acomp-data-input" value="${d.data}" />
      </td>
      <td class="num acomp-custo-celula">—</td>
      <td>
        <button class="sim-remover" onclick="removerFii('${f.ticker}')" title="Remover">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  atualizarCustoAcomp();
}

function atualizarCustoAcomp() {
  let custoTotal = 0;
  let linhasValidas = 0;
  document.querySelectorAll("#acomp-tbody tr[data-ticker]").forEach(tr => {
    const pm  = parseFloat(tr.querySelector(".acomp-pm-input")?.value)  || 0;
    const qtd = parseFloat(tr.querySelector(".acomp-qtd-input")?.value) || 0;
    const custo = pm * qtd;
    const cell = tr.querySelector(".acomp-custo-celula");
    if (cell) cell.textContent = custo > 0 ? formatarBRL(custo) : "—";
    custoTotal += custo;
    if (pm > 0 && qtd > 0) linhasValidas++;
  });

  const totalFooter = document.getElementById("acomp-total-custo");
  if (totalFooter) totalFooter.textContent = custoTotal > 0 ? formatarBRL(custoTotal) : "—";

  const totalTopbar = document.getElementById("acomp-custo-total");
  if (totalTopbar) totalTopbar.textContent = custoTotal > 0
    ? custoTotal.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "0,00";

  // Botão "Criar Carteira" só aparece se houver pelo menos 1 fundo com PM>0 e Qtd>0
  const btnWrap = document.getElementById("acomp-btn-wrapper");
  if (btnWrap) btnWrap.style.display = linhasValidas > 0 ? "flex" : "none";
}

// Cache local de histórico de preço (apenas nominal, para validação no submit
// de criação de carteira de acompanhamento). Espelha submeterOperacao no
// resultado.js — sem usar o cache de lá pois os dois scripts são separados.
const _histPrecoCacheSim = {};
const _DIRS_TICKER_SIM = ["fiis", "infra", "agro"];
async function _carregarHistPrecoSim(ticker) {
  if (_histPrecoCacheSim[ticker] !== undefined) return _histPrecoCacheSim[ticker];
  for (const dir of _DIRS_TICKER_SIM) {
    try {
      const r = await fetch(`data/${dir}/${ticker}.json`);
      if (r.ok) {
        const d = await r.json();
        const mapa = {};
        for (const [data, p] of (d.historico_preco || [])) mapa[data] = p;
        _histPrecoCacheSim[ticker] = mapa;
        return mapa;
      }
    } catch {}
  }
  _histPrecoCacheSim[ticker] = {};
  return {};
}

// Valida cada linha de compra inicial: data ≤ hoje, data ≥ IPO do fundo, e
// preço dentro de 50% da cotação histórica (pede confirmação se não).
// Retorna {ok:true} | {erro:string} | {cancelado:true}.
async function _validarLinhasAcomp(linhas) {
  const hoje = new Date().toISOString().slice(0, 10);
  for (const l of linhas) {
    if (l.data > hoje) {
      return { erro: `${l.ticker}: a data da compra não pode ser futura.` };
    }
    const mapa = await _carregarHistPrecoSim(l.ticker);
    const datas = Object.keys(mapa);
    if (!datas.length) {
      return { erro: `${l.ticker}: sem dados de preço disponíveis para validação.` };
    }
    let primeira = datas[0];
    for (const d of datas) if (d < primeira) primeira = d;
    if (l.data < primeira) {
      const [a, m, d] = primeira.split("-");
      return { erro: `${l.ticker} só tem dados a partir de ${d}/${m}/${a}.` };
    }
    let precoMercado = mapa[l.data];
    if (precoMercado == null) {
      let melhor = null;
      for (const d of datas) {
        if (d <= l.data && (melhor === null || d > melhor)) melhor = d;
      }
      if (melhor) precoMercado = mapa[melhor];
    }
    if (precoMercado != null && precoMercado > 0) {
      const desvio = Math.abs(l.preco - precoMercado) / precoMercado;
      if (desvio > 0.5) {
        const [a, m, d] = l.data.split("-");
        const ok = confirm(
          `${l.ticker}: o preço informado (${formatarBRL(l.preco)}) está ${(desvio * 100).toFixed(0)}% ` +
          `distante da cotação histórica em ${d}/${m}/${a} (${formatarBRL(precoMercado)}).\n\n` +
          `Quer mesmo registrar essa compra?`
        );
        if (!ok) return { cancelado: true };
      }
    }
  }
  return { ok: true };
}

async function criarCarteiraAcomp() {
  // Cada linha preenchida vira UMA transação inicial de compra.
  const transacoes = [];
  document.querySelectorAll("#acomp-tbody tr[data-ticker]").forEach(tr => {
    const qtd   = parseFloat(tr.querySelector(".acomp-qtd-input")?.value) || 0;
    const preco = parseFloat(tr.querySelector(".acomp-pm-input")?.value)  || 0;
    const data  = tr.querySelector(".acomp-data-input")?.value || "";
    if (qtd > 0 && preco > 0 && data) {
      transacoes.push({ ticker: tr.dataset.ticker, tipo: "compra", qtd, preco, data });
    }
  });

  // Paridade com submeterOperacao no resultado.js: data ≤ hoje, data ≥ IPO do
  // fundo, preço dentro de 50% da cotação. Sem isso, dá pra criar carteira
  // com data futura ou anterior à abertura do fundo, e a validação só aparece
  // quando o usuário tenta editar depois.
  const v = await _validarLinhasAcomp(transacoes);
  if (v.erro)       { alert(v.erro); return; }
  if (v.cancelado)  { return; }

  const nomeCarteira = document.getElementById("carteira-nome")?.value || "Sem nome";

  localStorage.setItem("acomp_carteira",      JSON.stringify(carteira));
  localStorage.setItem("acomp_transacoes",    JSON.stringify(transacoes));
  localStorage.removeItem("acomp_posicoes");
  localStorage.setItem("acomp_nome_carteira", nomeCarteira);
  localStorage.setItem("sim_tipo",            "acompanhamento");

  // Auto-save no Firestore — AWAIT antes de redirecionar para que o
  // localStorage.acomp_carteira_id já esteja correto quando resultado.html
  // carregar (caso contrário pode sobrescrever outra carteira).
  if (window.currentUser && typeof salvarCarteiraFirestore === "function") {
    try {
      const id = await salvarCarteiraFirestore(window.carteiraAtualId || null, {
        name:       nomeCarteira,
        tipo:       "acompanhamento",
        carteira:   carteira,
        transacoes: transacoes,
      });
      if (id) {
        window.carteiraAtualId = id;
        localStorage.setItem("acomp_carteira_id", id);
      }
    } catch (e) {
      // Se falhou, garante que não há ID antigo apontando pra outra carteira
      localStorage.removeItem("acomp_carteira_id");
      const isLimit = e?.code === "limit-exceeded";
      alert(isLimit ? e.message : "Erro ao salvar carteira: " + e.message);
      return;
    }
  } else {
    // Sem login: garante que não fica ID de outra sessão grudado
    localStorage.removeItem("acomp_carteira_id");
  }

  window.location.href = "resultado.html";
}

function formatarBRL(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseValorCarteira(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/\./g, "").replace(",", ".")) || 0;
}

function formatarInputCarteira() {
  const inp = document.getElementById("sim-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0
    ? val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "";
  atualizarTotal();
}

function desformatarInputCarteira() {
  const inp = document.getElementById("sim-valor-total");
  const val = parseValorCarteira(inp.value);
  inp.value = val > 0 ? String(val).replace(".", ",") : "";
}

function atualizarTotal() {
  const inputs   = document.querySelectorAll(".sim-peso-input");
  const totalEl  = document.getElementById("sim-total-valor");
  const totalPos = document.getElementById("sim-total-posicao");
  const aviso    = document.getElementById("sim-aviso");
  const valorCarteira = parseValorCarteira(document.getElementById("sim-valor-total")?.value);

  let soma = 0;
  inputs.forEach(inp => { soma += parseFloat(inp.value) || 0; });

  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp     = tr.querySelector(".sim-peso-input");
    const posCell = tr.querySelector(".sim-posicao-valor");
    if (!inp || !posCell) return;
    const peso = parseFloat(inp.value) || 0;
    posCell.textContent = valorCarteira > 0
      ? formatarBRL((peso / 100) * valorCarteira)
      : "—";
  });

  if (totalPos) {
    totalPos.textContent = valorCarteira > 0
      ? formatarBRL((soma / 100) * valorCarteira)
      : "—";
  }

  totalEl.textContent = soma.toFixed(2) + "%";

  const btnWrapper = document.getElementById("sim-btn-wrapper");
  const diff = Math.abs(soma - 100);
  if (!carteira.length) {
    aviso.style.display = "none";
    totalEl.className = "num";
    btnWrapper.style.display = "none";
  } else if (diff < 0.01) {
    totalEl.className = "num sim-total-ok";
    aviso.style.display = "none";
    btnWrapper.style.display = "flex";
  } else {
    totalEl.className = "num sim-total-erro";
    aviso.style.display = "block";
    aviso.textContent = soma < 100
      ? `A soma dos pesos é ${soma.toFixed(2)}% — faltam ${(100 - soma).toFixed(2)}% para chegar a 100%.`
      : `A soma dos pesos é ${soma.toFixed(2)}% — reduza ${(soma - 100).toFixed(2)}% para chegar a 100%.`;
    btnWrapper.style.display = "none";
  }
}

async function simularCarteira() {
  const pesos = {};
  document.querySelectorAll("tr[data-ticker]").forEach(tr => {
    const inp = tr.querySelector(".sim-peso-input");
    if (inp) pesos[tr.dataset.ticker] = parseFloat(inp.value) || 0;
  });

  const valorTotal = parseValorCarteira(document.getElementById("sim-valor-total")?.value);
  const nomeCarteira = document.getElementById("carteira-nome")?.value || "Sem nome";

  localStorage.setItem("sim_carteira",      JSON.stringify(carteira));
  localStorage.setItem("sim_pesos",         JSON.stringify(pesos));
  localStorage.setItem("sim_valor_total",   String(valorTotal));
  localStorage.setItem("sim_nome_carteira", nomeCarteira);
  localStorage.setItem("sim_tipo",          "simulacao");

  if (window.currentUser && typeof salvarCarteiraFirestore === "function") {
    try {
      const id = await salvarCarteiraFirestore(window.carteiraAtualId || null, {
        name: nomeCarteira,
        tipo: "simulacao",
        carteira: carteira,
        pesos: pesos,
        valor_total: valorTotal
      });
      if (id) {
        window.carteiraAtualId = id;
        localStorage.setItem("sim_carteira_id", id);
      }
    } catch (e) {
      localStorage.removeItem("sim_carteira_id");
      const isLimit = e?.code === "limit-exceeded";
      alert(isLimit ? e.message : "Erro ao salvar carteira: " + e.message);
      return;
    }
  } else {
    localStorage.removeItem("sim_carteira_id");
  }

  window.location.href = "resultado.html";
}

carregarDados();
