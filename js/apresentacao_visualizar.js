// apresentacao_visualizar.js — editor de textos qualitativos das apresentacoes
// setoriais. Persistencia em Firestore (collection apresentacoes_overrides),
// geracao do .pptx no browser via pptxgenjs.
//
// MVP atual: setor Logistica. Expansao pra outros setores e simples (adicionar
// no SETORES_CONFIG).

(function () {
  "use strict";

  const SETORES_CONFIG = {
    Logistica: {
      label: "Logística",
      keyIndex: "Logística",       // chave no data/index.json:fiis[].Setor
      icon: "layer",
    },
  };

  const PALETTE = {
    INK: "010D3D", INK2: "10204F", PAPER: "FFFFFF",
    TEXT: "1B2B38", MUTED: "5E7080", ICE: "CFE0EC", ICEMUT: "8FA6B8",
    ACCENT: "EC7000", POS: "12876B", NEG: "C0492F",
    DIVc: "C85A00", OPC: "1E5A8C",
    CARDPOS: "ECF6F2", CARDNEG: "FBEEEA", CARDDIV: "FCF1E7",
    CARDOP: "EAF1F7", CARDUPD: "FBF3EC",
  };
  const FOOTER = "Auto-gerado a partir dos JSONs do site + edicoes salvas no Firestore.";
  const MONTHS = ["jul", "ago", "set", "out", "nov", "dez", "jan", "fev", "mar", "abr", "mai", "jun"];
  const TOP_N = 8;

  // ---------- Estado ----------
  const state = {
    setor: null,           // ex: "Logistica"
    setorLabel: null,      // ex: "Logística"
    fiis: [],              // array de objetos FII auto-populated + overrides
    dirtyTickers: new Set(),
    ret: {},               // { ticker: { fii: [...], setor: [...] } }
    op:  {},               // { ticker: [{p,f,s,fv,sv}, ...] }
    booting: true,
  };

  // ---------- Boot ----------
  document.addEventListener("DOMContentLoaded", iniciar);

  async function iniciar() {
    const setor = (new URLSearchParams(location.search)).get("setor") || "Logistica";
    const cfg = SETORES_CONFIG[setor];
    if (!cfg) {
      mostrarErro(`Setor "${setor}" nao suportado ainda. Veja SETORES_CONFIG em apresentacao_visualizar.js.`);
      return;
    }
    state.setor = setor;
    state.setorLabel = cfg.label;
    document.getElementById("setor-label").textContent = cfg.label;
    document.title = `FIIs em Foco — ${cfg.label}`;

    document.getElementById("btn-salvar").addEventListener("click", salvarTudo);
    document.getElementById("btn-baixar").addEventListener("click", baixarPptx);

    try {
      const top = await carregarDadosBase(cfg);
      await aguardarAuth();
      if (!window.currentUser) {
        document.getElementById("auth-warn").style.display = "block";
        document.getElementById("auth-warn").innerHTML =
          'Faça login no <a href="simulador.html">Simulador de Carteira</a> primeiro pra carregar seus textos salvos e salvar novas edições. O editor abre normalmente — você pode editar e baixar o .pptx sem login.';
      } else {
        // Carrega overrides — se falhar (rules nao configuradas), apenas avisa
        // e segue com defaults
        try {
          await carregarOverrides(top);
        } catch (e) {
          if (e && (e.code === "permission-denied" || /permission/i.test(e.message))) {
            mostrarWarnRules();
          } else {
            console.warn("carregarOverrides falhou:", e);
          }
        }
      }
      state.fiis = top;
      renderizar();
      atualizarSaveState("saved");
    } catch (e) {
      mostrarErro("Erro carregando dados: " + (e && e.message || e));
    } finally {
      state.booting = false;
    }
  }

  function mostrarWarnRules() {
    const warn = document.getElementById("auth-warn");
    warn.style.display = "block";
    warn.style.background = "#fbeeea";
    warn.style.borderColor = "#e0a795";
    warn.style.color = "#7a2415";
    warn.innerHTML = `
      <strong>Firestore: regras de seguranca nao permitem acesso a "apresentacoes_overrides".</strong><br>
      O editor abre normalmente e voce pode baixar o .pptx, mas Salvar nao funcionara
      ate adicionar as regras no Firebase Console.<br><br>
      Adicione em <code>Firestore Rules</code>:<br>
      <pre style="background:#fff; border:1px solid #ddd; padding:8px; border-radius:4px; font-size:12px; margin-top:8px; overflow-x:auto;">match /apresentacoes_overrides/{docId} {
  allow read, write: if request.auth != null;
}</pre>
      <small>Cole esse bloco dentro do <code>match /databases/{database}/documents</code> ja existente.</small>
    `;
  }

  function aguardarAuth() {
    return new Promise(resolve => {
      if (window.currentUser !== undefined) {
        // se nao mudar em 500ms, segue mesmo sem login (sera readonly)
        setTimeout(resolve, 400);
      }
      document.addEventListener("auth-state-changed", () => resolve(), { once: true });
    });
  }

  // ---------- Helpers de fetch + format ----------
  async function getJson(rel) {
    const v = Math.floor(Date.now() / 60000);
    const r = await fetch(rel + "?v=" + v);
    if (!r.ok) throw new Error(`fetch ${rel}: HTTP ${r.status}`);
    return r.json();
  }
  function fmtBRL(v) { return v == null ? "—" : "R$ " + v.toFixed(2).replace(".", ","); }
  function fmtPct(v, d) { return (v == null || isNaN(v)) ? "—" : (v * 100).toFixed(d ?? 1).replace(".", ",") + "%"; }
  function fmtPctRaw(v, d) { return (v == null || isNaN(v)) ? "—" : v.toFixed(d ?? 1).replace(".", ",") + "%"; }
  function fmtPL(plBI) {
    if (plBI == null) return "—";
    if (plBI >= 1) return "R$ " + plBI.toFixed(1).replace(".", ",") + " bi";
    return "R$ " + Math.round(plBI * 1000) + " mi";
  }

  // ---------- Carrega dados base ----------
  async function carregarDadosBase(cfg) {
    const [idx, pesos, sret, fund] = await Promise.all([
      getJson("data/index.json"),
      getJson("data/pesos_ifix_historico.json"),
      getJson("data/setores_retorno.json"),
      getJson("data/fundamentos_renda_urbana.json").catch(() => null),
    ]);

    // Top FIIs do setor por peso atual
    const tickersDoSetor = (idx.fiis || []).filter(f => f.Setor === cfg.keyIndex);
    const comPeso = tickersDoSetor.map(f => ({
      ticker: f.Ticker,
      peso: pesoUltimo(pesos, f.Ticker),
    })).sort((a, b) => b.peso - a.peso).slice(0, TOP_N);

    // Calcula serie do setor (12m, base 0)
    const retSetor = retorno12mSetor(sret, cfg.keyIndex);

    // Pra cada ticker, carrega fiis/T.json, proventos/T.json, historico_v2/T.json
    const top = [];
    for (const item of comPeso) {
      const tk = item.ticker;
      const [fiiDoc, provDoc, ajustadoDoc] = await Promise.all([
        getJson(`data/fiis/${tk}.json`).catch(() => null),
        getJson(`data/proventos/${tk}.json`).catch(() => null),
        getJson(`data/historico_precos_v2/ajustado/${tk}.json`).catch(() => null),
      ]);
      const idxRow = idx.fiis.find(x => x.Ticker === tk);
      const obj = montarFII(idxRow, fiiDoc, provDoc, cfg.keyIndex, fund);

      const retFii = ajustadoDoc && ajustadoDoc.serie ? retorno12m(ajustadoDoc.serie) : null;
      state.ret[tk] = {
        fii: retFii || new Array(12).fill(0),
        setor: retSetor || new Array(12).fill(0),
      };
      state.op[tk] = operacionalDoFII(tk, cfg.keyIndex, fund, fiiDoc);

      top.push(obj);
    }
    return top;
  }

  function pesoUltimo(pesosHist, ticker) {
    const lista = (pesosHist.tickers && pesosHist.tickers[ticker]) || [];
    if (!lista.length) return 0;
    const ultima = lista.reduce((a, b) => (a[0] > b[0] ? a : b));
    return ultima[1] || 0;
  }

  function retorno12m(serie) {
    if (!serie || !serie.length) return null;
    const ultima = new Date(serie[serie.length - 1][0]);
    const mesesAlvo = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(ultima.getFullYear(), ultima.getMonth() - i, 1);
      mesesAlvo.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const ultPorMes = {};
    for (const [dt, v] of serie) {
      const m = dt.slice(0, 7);
      if (mesesAlvo.includes(m)) ultPorMes[m] = v;
    }
    let base = null;
    const prevData = new Date(ultima.getFullYear(), ultima.getMonth() - 12, 1);
    const prevMes = `${prevData.getFullYear()}-${String(prevData.getMonth() + 1).padStart(2, "0")}`;
    for (let i = serie.length - 1; i >= 0; i--) {
      if (serie[i][0].slice(0, 7) === prevMes) { base = serie[i][1]; break; }
    }
    if (!base) base = serie[0][1];
    const out = mesesAlvo.map(m => {
      const v = ultPorMes[m];
      return v == null ? null : (v / base - 1) * 100;
    });
    for (let i = 1; i < out.length; i++) if (out[i] == null) out[i] = out[i - 1];
    if (out[0] == null) out[0] = 0;
    const b = out[0];
    return out.map(x => +(x - b).toFixed(2));
  }

  function retorno12mSetor(setoresRet, setor) {
    const ind = setoresRet.indices && setoresRet.indices[setor];
    if (!ind || ind.length < 13) return null;
    return retorno12m(ind);
  }

  function ultimoProvento(prov) {
    if (!prov || !prov.proventos || !prov.proventos.length) return null;
    return prov.proventos.slice().sort((a, b) => (a.data_com > b.data_com ? -1 : 1))[0];
  }

  function operacionalDoFII(ticker, setor, fund, fiiDoc) {
    const isPapel = setor === "Crédito Imobiliário";
    let vac = null, ltv = null;
    if (fund && fund.fundos) {
      const f = fund.fundos.find(x => x.ticker === ticker);
      if (f) {
        if (f.vacancia != null) vac = f.vacancia * 100;
        if (f.ltv != null) ltv = f.ltv * 100;
      }
    }
    if (isPapel) {
      return [
        { p: "Alavancagem", f: "0%", s: "6%", fv: 0, sv: 6 },
        { p: "Caixa / Ativo", f: "8,0%", s: "6,0%", fv: 8, sv: 6 },
        { p: "Vacância", f: "n/a", s: "n/a", fv: null, sv: null },
        { p: "Prazo médio", f: "n/a", s: "n/a", fv: null, sv: null },
        { p: "Preço / m²", f: "n/a", s: "n/a", fv: null, sv: null },
      ];
    }
    return [
      { p: "Alavancagem",   f: ltv != null ? fmtPctRaw(ltv, 0) : "—", s: "22%",     fv: ltv ?? 0, sv: 22 },
      { p: "Caixa / Ativo", f: "—",                                  s: "5,0%",    fv: 5,        sv: 5 },
      { p: "Vacância",      f: vac != null ? fmtPctRaw(vac, 1) : "—", s: "9,5%",    fv: vac ?? 0, sv: 9.5 },
      { p: "Prazo médio",   f: "—",                                  s: "4,0 anos", fv: 4,       sv: 4 },
      { p: "Preço / m²",    f: "—",                                  s: "—",        fv: null,    sv: null },
    ];
  }

  function montarFII(idxRow, fiiDoc, provDoc, setor, fund) {
    const cota = idxRow["Preço Atual"];
    const dy = idxRow["DY a.a."];
    const pvp = idxRow["P/VP"];
    const vpcota = idxRow["VP/cota"];
    const ret12m = idxRow["Retorno - 12M"];
    const ultProv = ultimoProvento(provDoc);
    const last = ultProv ? `R$ ${ultProv.valor.toFixed(2).replace(".", ",")}/cota` : "—";
    let guideDefault = "—", dyprojDefault = "—";
    if (ultProv && cota) {
      const lo = ultProv.valor * 0.95, hi = ultProv.valor * 1.05;
      guideDefault = `R$ ${lo.toFixed(2).replace(".", ",")} – ${hi.toFixed(2).replace(".", ",")}`;
      const dy_lo = (12 * lo) / cota, dy_hi = (12 * hi) / cota;
      dyprojDefault = `${fmtPct(dy_lo)} – ${fmtPct(dy_hi)} a.a.`;
    }
    return {
      ticker: idxRow.Ticker,
      name: idxRow.Nome || idxRow.Ticker,
      segment: idxRow.Setor || "",
      cota: cota != null ? fmtBRL(cota) : "—",
      dy:   dy != null ? fmtPct(dy) : "—",
      pvp:  pvp != null ? pvp.toFixed(2).replace(".", ",") : "—",
      vpcota: vpcota != null ? fmtBRL(vpcota) : "—",
      extraLabel: "Retorno 12M",
      extra: ret12m != null ? fmtPct(ret12m) : "—",
      last,
      icon: setor === "Crédito Imobiliário" ? "coins" : setor === "Escritórios" ? "city" : "layer",
      // Editaveis (override defaults)
      update:    ["", ""],
      pos:       ["", "", ""],
      risk:      ["", "", ""],
      guide:     guideDefault,
      dyproj:    dyprojDefault,
      guidedir:  "flat",  // up / down / flat
      _hasOverride: false,
    };
  }

  // ---------- Firestore ----------
  function docRef(ticker) {
    return firebase.firestore().collection("apresentacoes_overrides")
      .doc(`${state.setor}_${ticker}`);
  }

  async function carregarOverrides(fiis) {
    if (!window.currentUser) return; // sem login, segue com defaults
    const refs = fiis.map(f => docRef(f.ticker).get());
    const snaps = await Promise.all(refs);
    snaps.forEach((snap, i) => {
      if (snap.exists) {
        const d = snap.data() || {};
        const f = fiis[i];
        if (Array.isArray(d.update))  f.update = d.update.length ? d.update : f.update;
        if (Array.isArray(d.pos))     f.pos    = d.pos.length    ? d.pos    : f.pos;
        if (Array.isArray(d.risk))    f.risk   = d.risk.length   ? d.risk   : f.risk;
        if (typeof d.guide === "string" && d.guide.trim())   f.guide   = d.guide;
        if (typeof d.dyproj === "string" && d.dyproj.trim()) f.dyproj  = d.dyproj;
        if (["up", "down", "flat"].includes(d.guidedir))     f.guidedir = d.guidedir;
        f._hasOverride = true;
      }
    });
  }

  async function salvarTudo() {
    if (!window.currentUser) {
      alert("Faça login no Simulador primeiro pra poder salvar.");
      return;
    }
    if (state.dirtyTickers.size === 0) {
      alert("Nenhuma alteração pra salvar.");
      return;
    }
    const btn = document.getElementById("btn-salvar");
    btn.disabled = true; btn.textContent = "Salvando…";
    try {
      const dirty = Array.from(state.dirtyTickers);
      for (const tk of dirty) {
        const f = state.fiis.find(x => x.ticker === tk);
        if (!f) continue;
        try {
          await docRef(tk).set({
            update: f.update.filter(x => x.trim()),
            pos:    f.pos.filter(x => x.trim()),
            risk:   f.risk.filter(x => x.trim()),
            guide:  f.guide || "",
            dyproj: f.dyproj || "",
            guidedir: f.guidedir,
            updated_at: firebase.firestore.Timestamp.now(),
            updated_by: window.currentUser.email || window.currentUser.uid,
          }, { merge: true });
          f._hasOverride = true;
        } catch (e) {
          if (e && (e.code === "permission-denied" || /permission/i.test(e.message))) {
            mostrarWarnRules();
            throw new Error("Firestore bloqueou o salvamento — veja o aviso acima sobre as regras.");
          }
          throw e;
        }
      }
      state.dirtyTickers.clear();
      atualizarSaveState("saved");
      // Atualiza badges visuais
      document.querySelectorAll(".fii-card[data-ticker]").forEach(el => {
        const tk = el.dataset.ticker;
        const f = state.fiis.find(x => x.ticker === tk);
        if (f) {
          const badge = el.querySelector(".sync-badge");
          if (badge) badge.textContent = "Salvo";
        }
      });
    } catch (e) {
      alert("Erro ao salvar: " + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = "Salvar edições";
    }
  }

  function marcarDirty(ticker, card) {
    state.dirtyTickers.add(ticker);
    atualizarSaveState("dirty");
    if (card) {
      const badge = card.querySelector("[data-badge]");
      if (badge) { badge.textContent = "Edição não salva"; badge.className = "sync-badge dirty"; }
    }
  }
  function atualizarSaveState(s) {
    const el = document.getElementById("save-state");
    el.className = "save-state " + s;
    el.textContent = s === "dirty" ? `${state.dirtyTickers.size} fundo(s) editado(s)`
                   : s === "saved" ? "Tudo salvo"
                   : "—";
  }

  // ---------- Render ----------
  function renderizar() {
    const root = document.getElementById("lista-fiis");
    root.innerHTML = "";
    for (const f of state.fiis) {
      root.appendChild(cardFII(f));
    }
  }

  // Helper: lista <ul><li> a partir de array de strings
  function ulHTML(items) {
    const arr = (items || []).filter(s => s && String(s).trim());
    if (!arr.length) return "";
    return "<ul>" + arr.map(s => `<li>${escapeHtml(s)}</li>`).join("") + "</ul>";
  }

  // Helper: gera SVG do gráfico de retorno 12m (FII + setor)
  function chartSvgRetorno(serieFii, serieSetor) {
    const w = 100, h = 40, pl = 8, pr = 4, pt = 4, pb = 10;
    const all = (serieFii || []).concat(serieSetor || []);
    if (!all.length) return "";
    const mn = Math.min(0, ...all), mx = Math.max(0, ...all);
    const range = (mx - mn) || 1;
    const n = (serieFii || []).length;
    function pts(arr) {
      return arr.map((v, i) => {
        const x = pl + ((w - pl - pr) * i) / (n - 1 || 1);
        const y = h - pb - ((v - mn) / range) * (h - pt - pb);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      }).join(" ");
    }
    // y=0 gridline
    const y0 = h - pb - ((0 - mn) / range) * (h - pt - pb);
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pl}" x2="${w - pr}" y1="${y0.toFixed(2)}" y2="${y0.toFixed(2)}" stroke="#EAEEF2" stroke-width="0.4"/>
      <polyline fill="none" stroke="#9AA7B5" stroke-width="0.9" points="${pts(serieSetor)}"/>
      <polyline fill="none" stroke="#EC7000" stroke-width="1.2" points="${pts(serieFii)}"/>
    </svg>`;
  }

  function cardFII(f) {
    const card = document.createElement("section");
    card.className = "slide-card";
    card.dataset.ticker = f.ticker;

    const ret = state.ret[f.ticker] || { fii: [], setor: [] };
    const opData = state.op[f.ticker] || [];
    const dirSym = { up: "↑", down: "↓", flat: "=" };
    const dirLabel = { up: "Em alta", down: "Em queda", flat: "Estável" };
    const dir = f.guidedir || "flat";

    const opRowsHtml = opData.map(row => {
      if (row.fv === null) {
        return `<div class="op-row"><div>${escapeHtml(row.p)}</div><div class="op-na">n/a</div><div></div></div>`;
      }
      const mv = Math.max(row.fv, row.sv) || 1;
      const fW = Math.max(3, (row.fv / mv) * 100);
      const sW = Math.max(3, (row.sv / mv) * 100);
      return `<div class="op-row">
        <div>${escapeHtml(row.p)}</div>
        <div class="op-bar-wrap">
          <div class="op-bar fundo" style="width:${fW.toFixed(1)}%"></div>
          <div class="op-bar setor" style="width:${sW.toFixed(1)}%"></div>
        </div>
        <div>
          <div class="op-val-fundo">${escapeHtml(row.f)}</div>
          <div class="op-val-setor">${escapeHtml(row.s)}</div>
        </div>
      </div>`;
    }).join("");

    card.innerHTML = `
      <div class="slide-meta">
        <div class="ticker-meta">${f.ticker} <span style="font-weight:400;color:#6b727a;">— ${escapeHtml(f.name || "")}</span></div>
        <div class="sync-badge ${f._hasOverride ? "saved" : ""}" data-badge>${f._hasOverride ? "Salvo no Firestore" : "Padrão (sem edição)"}</div>
      </div>
      <div class="slide" data-slide>
        <!-- Painel esquerdo (identidade) -->
        <aside class="slide-left">
          <div class="ticker">${f.ticker}</div>
          <div class="seg-pill">${escapeHtml(f.segment || "—")}</div>
          <div class="fund-name">${escapeHtml(f.name || "")}</div>

          <div class="stat"><div class="v">${f.cota}</div><div class="l">COTA (FECHAMENTO)</div></div>
          <div class="stat"><div class="v">${f.dy}</div><div class="l">DIVIDEND YIELD 12M</div></div>
          <div class="stat"><div class="v">${f.pvp}</div><div class="l">P / VP</div></div>
          <div class="stat"><div class="v">${f.vpcota}</div><div class="l">VP / COTA</div></div>
          <div class="stat"><div class="v">${f.extra}</div><div class="l">${(f.extraLabel || "").toUpperCase()}</div></div>
        </aside>

        <!-- Conteudo direito -->
        <section class="slide-right">
          <!-- Linha 1: update + guidance -->
          <div class="slide-row r1">
            <div class="slide-card-block update">
              <div class="head">
                <span class="circ" style="background:#EC7000;">⚡</span>
                <span class="head-title">Atualização do mês</span>
              </div>
              <div class="editable" data-field="update" contenteditable="true"
                   data-placeholder="• Renovação do contrato com âncora.">${ulHTML(f.update)}</div>
            </div>

            <div class="slide-card-block guide">
              <select class="dir-select" data-field="guidedir">
                <option value="up"   ${dir==="up"   ? "selected" : ""}>↑</option>
                <option value="flat" ${dir==="flat" ? "selected" : ""}>=</option>
                <option value="down" ${dir==="down" ? "selected" : ""}>↓</option>
              </select>
              <div class="g-title">Guidance Proventos</div>
              <div class="g-range editable" data-field="guide" contenteditable="true"
                   data-placeholder="R$ 0,77 – 0,85">${escapeHtml(f.guide || "")}</div>
              <div class="g-dyproj editable" data-field="dyproj" contenteditable="true"
                   data-placeholder="9,0% – 9,9% a.a.">${escapeHtml(f.dyproj || "")}</div>
              <div class="g-arrow ${dir}" data-arrow>${dirSym[dir]}</div>
              <div class="g-label ${dir}" data-arrow-label>${dirLabel[dir]}</div>
            </div>
          </div>

          <!-- Linha 2: chart retorno + operacional -->
          <div class="slide-row r2">
            <div class="slide-card-block chart">
              <div class="head">
                <span class="circ" style="background:#010D3D;">📈</span>
                <span class="head-title">Retorno 12m vs setor</span>
              </div>
              ${chartSvgRetorno(ret.fii, ret.setor)}
            </div>

            <div class="slide-card-block op">
              <div class="head">
                <span class="circ" style="background:#1E5A8C;">🏢</span>
                <span class="head-title">Operacional</span>
              </div>
              <div class="op-legend">
                <span><span class="dot fundo"></span>Fundo</span>
                <span><span class="dot setor"></span>Setor</span>
              </div>
              <div class="op-rows">${opRowsHtml}</div>
            </div>
          </div>

          <!-- Linha 3: positivos + riscos -->
          <div class="slide-row r3">
            <div class="slide-card-block pos">
              <div class="head">
                <span class="circ" style="background:#12876B;">↗</span>
                <span class="head-title">Pontos positivos</span>
              </div>
              <div class="editable" data-field="pos" contenteditable="true"
                   data-placeholder="• Gestão consistente.">${ulHTML(f.pos)}</div>
            </div>

            <div class="slide-card-block risk">
              <div class="head">
                <span class="circ" style="background:#C0492F;">⚠</span>
                <span class="head-title">Principais riscos</span>
              </div>
              <div class="editable" data-field="risk" contenteditable="true"
                   data-placeholder="• Vacância em SP elevada.">${ulHTML(f.risk)}</div>
            </div>
          </div>

          <div class="footer-hint">Dados de proventos/operacional ilustrativos — confirmar com o último relatório gerencial.</div>
        </section>
      </div>
    `;

    // Edicao inline
    card.querySelectorAll(".editable[contenteditable=true]").forEach(el => {
      const field = el.dataset.field;
      el.addEventListener("input", () => {
        const fii = state.fiis.find(x => x.ticker === f.ticker);
        if (!fii) return;
        if (field === "update" || field === "pos" || field === "risk") {
          // Le texto puro e separa por quebras
          // Suporta tanto <ul><li> quanto plain text com \n
          const text = el.innerText || "";
          fii[field] = text.split(/\n/).map(s => s.trim()).filter(Boolean);
        } else {
          fii[field] = (el.innerText || "").trim();
        }
        marcarDirty(f.ticker, card);
      });
      // Quando perde foco, normaliza visualmente listas
      el.addEventListener("blur", () => {
        if (field === "update" || field === "pos" || field === "risk") {
          const fii = state.fiis.find(x => x.ticker === f.ticker);
          if (fii) el.innerHTML = ulHTML(fii[field]);
        }
      });
    });

    // Guidance direction select
    const dirSel = card.querySelector("select[data-field='guidedir']");
    if (dirSel) {
      dirSel.addEventListener("change", () => {
        const fii = state.fiis.find(x => x.ticker === f.ticker);
        if (!fii) return;
        fii.guidedir = dirSel.value;
        const arrEl = card.querySelector("[data-arrow]");
        const lblEl = card.querySelector("[data-arrow-label]");
        if (arrEl) { arrEl.textContent = dirSym[dirSel.value]; arrEl.className = "g-arrow " + dirSel.value; }
        if (lblEl) { lblEl.textContent = dirLabel[dirSel.value]; lblEl.className = "g-label " + dirSel.value; }
        marcarDirty(f.ticker, card);
      });
    }

    return card;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function mostrarErro(msg) {
    document.getElementById("lista-fiis").innerHTML =
      `<p style="color:#b42a2a; padding:20px; background:#fbeeea; border-radius:6px;">${escapeHtml(msg)}</p>`;
  }

  // ---------- Gerar .pptx no browser ----------
  async function baixarPptx() {
    if (state.dirtyTickers.size > 0) {
      const ok = confirm("Há edições não salvas. Quer baixar com as edições atuais (não salvas)?");
      if (!ok) return;
    }
    const btn = document.getElementById("btn-baixar");
    btn.disabled = true; btn.textContent = "Gerando…";
    try {
      const pres = await criarPptx();
      await pres.writeFile({ fileName: `FIIs_em_Foco_${state.setor}.pptx` });
    } catch (e) {
      alert("Erro ao gerar pptx: " + (e.message || e));
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = "↓ Baixar .pptx";
    }
  }

  async function criarPptx() {
    const PPT = window.PptxGenJS || window.pptxgen;
    if (!PPT) throw new Error("pptxgenjs nao carregou.");
    const pres = new PPT();
    pres.defineLayout({ name: "W", width: 13.333, height: 7.5 });
    pres.layout = "W";
    pres.title = `FIIs em Foco — ${state.setorLabel}`;
    pres.author = "ImobData";

    const ic = window.APRESENTACAO_ICONS;
    if (!ic) throw new Error("Ícones nao carregados.");

    const W = 13.333, H = 7.5;
    const P = PALETTE;
    const shadow = () => ({ type: "outer", color: "001A33", blur: 7, offset: 3, angle: 90, opacity: 0.16 });

    function iconCircle(s, x, y, d, fill, data) {
      s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { type: "none" } });
      const ip = d * 0.5;
      s.addImage({ data, x: x + (d - ip) / 2, y: y + (d - ip) / 2, w: ip, h: ip });
    }
    function card(s, x, y, w, h, fill) {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
        x, y, w, h, rectRadius: 0.09, fill: { color: fill }, line: { type: "none" }, shadow: shadow(),
      });
    }
    function cardHeader(s, cx, cy, cw, accent, iconData, title) {
      const d = 0.5;
      iconCircle(s, cx + 0.22, cy + 0.2, d, accent, iconData);
      s.addText(title, {
        x: cx + 0.22 + d + 0.18, y: cy + 0.2, w: cw - (0.22 + d + 0.18) - 0.2, h: d,
        fontSize: 14.5, bold: true, color: P.TEXT, fontFace: "Calibri", valign: "middle", margin: 0,
      });
    }
    function miniHeader(s, cx, cy, cw, accent, iconData, title) {
      const d = 0.4;
      iconCircle(s, cx + 0.2, cy + 0.13, d, accent, iconData);
      s.addText(title, {
        x: cx + 0.2 + d + 0.14, y: cy + 0.13, w: cw - (0.2 + d + 0.14) - 0.18, h: d,
        fontSize: 12.5, bold: true, color: P.TEXT, fontFace: "Calibri", valign: "middle", margin: 0,
      });
    }
    function bullets(s, x, y, w, h, items, fs) {
      const arr = (items || []).filter(t => t && String(t).trim());
      if (!arr.length) {
        s.addText("[Sem texto preenchido]", {
          x, y, w, h, fontSize: fs || 11, italic: true, color: P.MUTED, fontFace: "Calibri",
        });
        return;
      }
      s.addText(
        arr.map((t, i) => ({
          text: String(t),
          options: { bullet: { code: "2022", indent: 14 }, color: P.TEXT, breakLine: i < arr.length - 1, paraSpaceAfter: 5 },
        })),
        { x, y, w, h, fontSize: fs || 11, fontFace: "Calibri", valign: "top", color: P.TEXT, lineSpacingMultiple: 1.0 }
      );
    }

    const segIcon = { city: ic.city, building: ic.building, layer: ic.layer, coins: ic.coinsG };

    // COVER
    {
      const s = pres.addSlide();
      s.background = { color: P.INK };
      s.addShape(pres.shapes.OVAL, { x: 10.3, y: -1.6, w: 4.6, h: 4.6, fill: { color: P.INK2 }, line: { type: "none" } });
      s.addShape(pres.shapes.OVAL, { x: 11.6, y: 4.6, w: 3.4, h: 3.4, fill: { color: P.INK2 }, line: { type: "none" } });
      s.addText("MONITOR DE FUNDOS IMOBILIÁRIOS", {
        x: 0.9, y: 1.5, w: 9, h: 0.4, fontSize: 14, bold: true, color: P.ACCENT, charSpacing: 3, fontFace: "Calibri",
      });
      s.addText("FIIs em Foco", {
        x: 0.85, y: 1.95, w: 10, h: 1.2, fontSize: 60, bold: true, color: P.PAPER, fontFace: "Cambria",
      });
      s.addText(`Setor: ${state.setorLabel} — destaques, riscos, proventos e indicadores operacionais`, {
        x: 0.9, y: 3.25, w: 9.5, h: 0.6, fontSize: 17, color: P.ICE, fontFace: "Calibri",
      });
      const blocks = [
        { i: ic.bolt, c: P.ACCENT, t: "Atualização" },
        { i: ic.pos, c: P.POS, t: "Pontos positivos" },
        { i: ic.risk, c: P.NEG, t: "Riscos" },
        { i: ic.coins, c: P.DIVc, t: "Proventos" },
        { i: ic.op, c: P.OPC, t: "Operacional" },
      ];
      let bx = 0.9;
      blocks.forEach(b => {
        iconCircle(s, bx, 4.55, 0.62, b.c, b.i);
        s.addText(b.t, { x: bx - 0.45, y: 5.25, w: 1.52, h: 0.4, fontSize: 11, bold: true, color: P.ICE, align: "center", fontFace: "Calibri" });
        bx += 1.72;
      });
      s.addText(`${state.fiis.length} fundos do setor`, {
        x: 0.9, y: 6.5, w: 9, h: 0.4, fontSize: 12, italic: true, color: P.ICEMUT, fontFace: "Calibri",
      });
      s.addText(FOOTER, { x: 0.9, y: 6.95, w: 11.5, h: 0.3, fontSize: 9, color: P.ICEMUT, fontFace: "Calibri" });
    }

    // FII SLIDES
    for (const f of state.fiis) {
      const s = pres.addSlide();
      s.background = { color: P.PAPER };
      const LP = 3.55;
      s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: LP, h: H, fill: { color: P.INK }, line: { type: "none" } });
      s.addImage({ data: segIcon[f.icon] || segIcon.building, x: 2.95, y: 0.54, w: 0.5, h: 0.5, transparency: 15 });
      s.addText(f.ticker, { x: 0.42, y: 0.5, w: 2.45, h: 0.72, fontSize: 36, bold: true, color: P.PAPER, fontFace: "Cambria", wrap: false, margin: 0 });

      const plen = (f.segment || "").length;
      const pw = Math.min(2.95, 0.34 + plen * 0.073);
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.42, y: 1.32, w: pw, h: 0.34, rectRadius: 0.17, fill: { color: P.ACCENT }, line: { type: "none" } });
      s.addText(f.segment, { x: 0.42, y: 1.32, w: pw, h: 0.34, fontSize: 9.5, bold: true, color: P.INK, align: "center", valign: "middle", fontFace: "Calibri", margin: 0 });

      s.addText(f.name, { x: 0.42, y: 1.78, w: 2.85, h: 0.55, fontSize: 11.5, color: P.ICE, fontFace: "Calibri", valign: "top" });

      const stats = [
        { l: "Cota (fechamento)", v: f.cota },
        { l: "Dividend Yield 12m", v: f.dy },
        { l: "P/VP", v: f.pvp },
        { l: "VP / cota", v: f.vpcota },
        { l: f.extraLabel, v: f.extra },
      ];
      let sy = 2.62;
      stats.forEach(st => {
        s.addText(st.v, { x: 0.42, y: sy, w: 2.9, h: 0.45, fontSize: 23, bold: true, color: P.PAPER, fontFace: "Calibri", margin: 0 });
        s.addText((st.l || "").toUpperCase(), { x: 0.42, y: sy + 0.46, w: 2.9, h: 0.26, fontSize: 9, color: P.ICEMUT, charSpacing: 1, fontFace: "Calibri", margin: 0 });
        sy += 0.92;
      });

      // RIGHT
      const RX = 3.85, RW = W - RX - 0.48;
      const colW = (RW - 0.3) / 2;
      const RX2 = RX + colW + 0.3;
      const r1Y = 0.42, r1H = 1.62, sqW = 2.2;
      const aW = (RX2 + colW) - sqW - 0.28 - RX;

      card(s, RX, r1Y, aW, r1H, P.CARDUPD);
      cardHeader(s, RX, r1Y, aW, P.ACCENT, ic.bolt, "Atualização do mês");
      bullets(s, RX + 0.95, r1Y + 0.74, aW - 1.2, r1H - 0.85, f.update);

      const sqX = (RX2 + colW) - sqW;
      card(s, sqX, r1Y, sqW, r1H, P.CARDDIV);
      const cxS = sqX + sqW / 2;
      s.addText("Guidance Proventos", { x: sqX + 0.1, y: r1Y + 0.14, w: sqW - 0.2, h: 0.3, fontSize: 11.5, bold: true, color: P.TEXT, align: "center", fontFace: "Calibri", margin: 0 });
      s.addText(f.guide || "—", { x: sqX + 0.1, y: r1Y + 0.45, w: sqW - 0.2, h: 0.26, fontSize: 11, bold: true, color: P.DIVc, align: "center", fontFace: "Calibri", margin: 0 });
      const dirMap = {
        up:   { icon: ic.arrUp,   label: "Em alta",  col: P.POS },
        down: { icon: ic.arrDown, label: "Em queda", col: P.NEG },
        flat: { icon: ic.arrFlat, label: "Estável",  col: P.MUTED },
      };
      const dd = dirMap[f.guidedir || "flat"];
      s.addImage({ data: dd.icon, x: cxS - 0.27, y: r1Y + 0.72, w: 0.54, h: 0.54 });
      s.addText(dd.label, { x: sqX + 0.1, y: r1Y + 1.3, w: sqW - 0.2, h: 0.24, fontSize: 9.5, bold: true, color: dd.col, align: "center", fontFace: "Calibri", margin: 0 });

      const r2Y = r1Y + r1H + 0.16, r2H = 2.02;
      card(s, RX, r2Y, colW, r2H, P.PAPER);
      cardHeader(s, RX, r2Y, colW, P.INK, ic.chart, "Retorno 12m vs setor");
      const r = state.ret[f.ticker] || { fii: new Array(12).fill(0), setor: new Array(12).fill(0) };
      s.addChart(pres.charts.LINE, [
        { name: f.ticker, labels: MONTHS, values: r.fii },
        { name: "Média do setor", labels: MONTHS, values: r.setor },
      ], {
        x: RX + 0.16, y: r2Y + 0.66, w: colW - 0.32, h: r2H - 0.78,
        chartColors: [P.ACCENT, "9AA7B5"],
        lineSize: 2.25, lineSmooth: true, lineDataSymbol: "none",
        showLegend: true, legendPos: "b", legendFontSize: 8, legendColor: P.MUTED,
        showTitle: false,
        catAxisLabelColor: "8A97A8", catAxisLabelFontSize: 6,
        valAxisLabelColor: "8A97A8", valAxisLabelFontSize: 6.5,
        valAxisLabelFormatCode: '0"%"',
        valGridLine: { color: "EAEEF2", size: 0.5 }, catGridLine: { style: "none" },
      });

      card(s, RX2, r2Y, colW, r2H, P.CARDOP);
      miniHeader(s, RX2, r2Y, colW, P.OPC, ic.op, "Operacional");
      const lgX = RX2 + colW - 1.62, lgY = r2Y + 0.26;
      s.addShape(pres.shapes.RECTANGLE, { x: lgX, y: lgY, w: 0.13, h: 0.13, fill: { color: P.ACCENT }, line: { type: "none" } });
      s.addText("Fundo", { x: lgX + 0.17, y: lgY - 0.04, w: 0.55, h: 0.2, fontSize: 7.5, color: P.MUTED, fontFace: "Calibri", margin: 0 });
      s.addShape(pres.shapes.RECTANGLE, { x: lgX + 0.78, y: lgY, w: 0.13, h: 0.13, fill: { color: "9AA7B5" }, line: { type: "none" } });
      s.addText("Setor", { x: lgX + 0.95, y: lgY - 0.04, w: 0.55, h: 0.2, fontSize: 7.5, color: P.MUTED, fontFace: "Calibri", margin: 0 });

      const oData = state.op[f.ticker] || [];
      const lblW = 1.15, barX0 = RX2 + 0.2 + lblW + 0.05, barMaxW = 1.78, valX = RX2 + colW - 0.92;
      const oStartY = r2Y + 0.58, oStep = (r2H - 0.62) / Math.max(oData.length, 1);
      oData.forEach((row, i) => {
        const by = oStartY + i * oStep;
        s.addText(row.p, { x: RX2 + 0.2, y: by, w: lblW, h: oStep - 0.04, fontSize: 8, color: P.TEXT, fontFace: "Calibri", valign: "middle", margin: 0 });
        if (row.fv === null) {
          s.addText("n/a", { x: barX0, y: by, w: barMaxW, h: oStep - 0.04, fontSize: 8, italic: true, color: "9AA7B5", fontFace: "Calibri", valign: "middle", margin: 0 });
        } else {
          const mv = Math.max(row.fv, row.sv) || 1;
          const fW = Math.max(0.03, (row.fv / mv) * barMaxW);
          const sW = Math.max(0.03, (row.sv / mv) * barMaxW);
          s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: barX0, y: by + 0.04, w: fW, h: 0.08, rectRadius: 0.03, fill: { color: P.ACCENT }, line: { type: "none" } });
          s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: barX0, y: by + 0.145, w: sW, h: 0.08, rectRadius: 0.03, fill: { color: "9AA7B5" }, line: { type: "none" } });
          s.addText(row.f, { x: valX, y: by + 0.0, w: 0.85, h: 0.15, fontSize: 7.5, bold: true, color: P.OPC, fontFace: "Calibri", valign: "middle", margin: 0 });
          s.addText(row.s, { x: valX, y: by + 0.14, w: 0.85, h: 0.15, fontSize: 7.5, color: P.MUTED, fontFace: "Calibri", valign: "middle", margin: 0 });
        }
      });

      const r3Y = r2Y + r2H + 0.15, r3H = 2.61;
      card(s, RX, r3Y, colW, r3H, P.CARDPOS);
      cardHeader(s, RX, r3Y, colW, P.POS, ic.pos, "Pontos positivos");
      bullets(s, RX + 0.28, r3Y + 0.84, colW - 0.55, r3H - 0.98, f.pos);

      card(s, RX2, r3Y, colW, r3H, P.CARDNEG);
      cardHeader(s, RX2, r3Y, colW, P.NEG, ic.risk, "Principais riscos");
      bullets(s, RX2 + 0.28, r3Y + 0.84, colW - 0.55, r3H - 0.98, f.risk);

      s.addText(FOOTER, { x: RX, y: 7.14, w: RW, h: 0.25, fontSize: 8.5, italic: true, color: P.MUTED, fontFace: "Calibri", margin: 0 });
    }
    return pres;
  }
})();
