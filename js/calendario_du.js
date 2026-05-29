// Calendário de dias úteis B3 (Brasil). Feriados nacionais + móveis (Carnaval,
// Sexta-feira Santa, Corpus Christi) + os que a B3 não opera (24/12 e 31/12).
// Páscoa calculada pelo algoritmo de Butcher; horizonte: até 2100.
//
// Convenção: dia útil = não-sábado, não-domingo, não-feriado.
// Função principal: diasUteisEntre(d1, d2) -> int (exclui d1, inclui d2,
// padrão financeiro pra contagem de DU em períodos).

(function () {
  const _cacheAnos = new Map();   // ano -> Set de "YYYY-MM-DD" feriados

  function _pascoa(ano) {
    // Butcher 1876 — preciso até ano 2099
    const a = ano % 19;
    const b = Math.floor(ano / 100);
    const c = ano % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const L = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * L) / 451);
    const mes = Math.floor((h + L - 7 * m + 114) / 31);
    const dia = ((h + L - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(ano, mes - 1, dia));
  }

  function _addDias(date, n) {
    const r = new Date(date);
    r.setUTCDate(r.getUTCDate() + n);
    return r;
  }

  function _iso(date) {
    return date.toISOString().slice(0, 10);
  }

  function _feriadosDoAno(ano) {
    if (_cacheAnos.has(ano)) return _cacheAnos.get(ano);
    const pascoa = _pascoa(ano);
    const fer = new Set([
      `${ano}-01-01`,        // Confraternização Universal
      `${ano}-04-21`,        // Tiradentes
      `${ano}-05-01`,        // Dia do Trabalho
      `${ano}-09-07`,        // Independência
      `${ano}-10-12`,        // Padroeira
      `${ano}-11-02`,        // Finados
      `${ano}-11-15`,        // Proclamação da República
      `${ano}-11-20`,        // Consciência Negra (nacional desde 2024)
      `${ano}-12-25`,        // Natal
      // Móveis (relativos à Páscoa)
      _iso(_addDias(pascoa, -48)),  // Carnaval (segunda)
      _iso(_addDias(pascoa, -47)),  // Carnaval (terça)
      _iso(_addDias(pascoa,  -2)),  // Sexta-feira Santa
      _iso(_addDias(pascoa,  60)),  // Corpus Christi
      // B3 nao opera nesses dias:
      `${ano}-12-24`,        // véspera de Natal
      `${ano}-12-31`,        // último dia útil financeiro (fechamento de balanço)
    ]);
    _cacheAnos.set(ano, fer);
    return fer;
  }

  function ehDiaUtil(date) {
    // date: Date (UTC) ou string YYYY-MM-DD
    const d = (typeof date === "string") ? new Date(date + "T00:00:00Z") : date;
    const dow = d.getUTCDay();           // 0=domingo, 6=sabado
    if (dow === 0 || dow === 6) return false;
    const iso = _iso(d);
    return !_feriadosDoAno(d.getUTCFullYear()).has(iso);
  }

  function diasUteisEntre(d1ISO, d2ISO) {
    // Conta dias úteis em (d1, d2] — exclui d1, inclui d2 se for DU.
    // Convenção financeira para contagem de DU em períodos.
    if (!d1ISO || !d2ISO || d1ISO >= d2ISO) return 0;
    const d1 = new Date(d1ISO + "T00:00:00Z");
    const d2 = new Date(d2ISO + "T00:00:00Z");
    let cur = _addDias(d1, 1);
    let cnt = 0;
    while (cur <= d2) {
      if (ehDiaUtil(cur)) cnt++;
      cur = _addDias(cur, 1);
    }
    return cnt;
  }

  function proximoDiaUtil(dISO) {
    // Devolve a próxima data ISO que é DU (inclui a propria se for DU).
    let cur = new Date(dISO + "T00:00:00Z");
    while (!ehDiaUtil(cur)) cur = _addDias(cur, 1);
    return _iso(cur);
  }

  function proximaDataPagamento(dataEmissaoISO, mesesACorrer) {
    // Para CRI/CRA mensal: o pagamento cai no mesmo dia do mes, mas se nao
    // for DU, anda pra proximo DU. Caso o dia nao exista no mes (ex: 31/02),
    // usa ultimo dia do mes.
    const ref = new Date(dataEmissaoISO + "T00:00:00Z");
    const ano = ref.getUTCFullYear();
    const mes = ref.getUTCMonth() + mesesACorrer;
    const diaEmissao = ref.getUTCDate();
    const candidato = new Date(Date.UTC(ano, mes, diaEmissao));
    // Se o dia "saltou" (ex: 31 em fevereiro vira 03/mar), usa ultimo dia do mes ref
    if (candidato.getUTCMonth() !== ((mes % 12 + 12) % 12)) {
      candidato.setUTCDate(0);  // ultimo dia do mes anterior
    }
    return proximoDiaUtil(_iso(candidato));
  }

  // Exporta no global pra outros scripts usarem
  window.CalendarioDU = {
    ehDiaUtil,
    diasUteisEntre,
    proximoDiaUtil,
    proximaDataPagamento,
  };
})();
