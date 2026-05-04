// ntnb-utils.js — calcula série de NTN-B com duration constante (em anos),
// reaproveitada pelas páginas de Spread e Relatório Mensal. Mesma lógica
// de interpolação linear entre os 2 títulos vizinhos por duration usada
// originalmente em spread.js.

function ntnbCalcularSerie(dadosNtnb, targetAnos) {
  // Índice YTM por data: { date: { bond: ytm } }
  const ytmPorData = {};
  for (const bond of Object.keys(dadosNtnb.ytm)) {
    for (const [dt, val] of dadosNtnb.ytm[bond]) {
      if (!ytmPorData[dt]) ytmPorData[dt] = {};
      ytmPorData[dt][bond] = val;
    }
  }

  // Duration: forward-fill por bond (publicada em frequência menor que YTM)
  const durSeries = {};
  for (const bond of Object.keys(dadosNtnb.duration)) {
    durSeries[bond] = dadosNtnb.duration[bond].slice().sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  function getDur(bond, dt) {
    const serie = durSeries[bond];
    if (!serie || !serie.length) return null;
    let val = null;
    for (const [d, v] of serie) {
      if (d <= dt) val = v; else break;
    }
    return val;
  }

  const todasDatas = Object.keys(ytmPorData).sort();
  const saida = [];
  for (const dt of todasDatas) {
    const ytmMap = ytmPorData[dt];
    const durMap = {};
    for (const bond of Object.keys(ytmMap)) {
      const d = getDur(bond, dt);
      if (d !== null) durMap[bond] = d;
    }
    const ytmInterp = ntnbInterpolarDia(ytmMap, durMap, targetAnos);
    if (ytmInterp !== null) saida.push({ date: dt, ytm: ytmInterp });
  }
  return saida;
}

function ntnbInterpolarDia(ytmMap, durMap, targetAnos) {
  const pontos = [];
  for (const bond of Object.keys(ytmMap)) {
    const ytm = ytmMap[bond];
    const durDias = durMap[bond];
    if (ytm == null || durDias == null) continue;
    pontos.push({ ytm, durAnos: durDias / 365 });
  }
  if (pontos.length < 2) return null;
  pontos.sort((a, b) => a.durAnos - b.durAnos);

  const minDur = pontos[0].durAnos;
  const maxDur = pontos[pontos.length - 1].durAnos;
  if (targetAnos < minDur || targetAnos > maxDur) return null;

  for (let i = 0; i < pontos.length - 1; i++) {
    const lo = pontos[i], hi = pontos[i + 1];
    if (lo.durAnos <= targetAnos && hi.durAnos >= targetAnos) {
      if (hi.durAnos === lo.durAnos) return lo.ytm;
      return lo.ytm + (targetAnos - lo.durAnos) / (hi.durAnos - lo.durAnos) * (hi.ytm - lo.ytm);
    }
  }
  return null;
}
