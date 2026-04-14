/* dcf.js — Calculadora DCF para FIIs */

function calcularDCF() {
  const dividendoMensal = parseFloat(document.getElementById("dcf-dividendo").value);
  const crescimentoAnual = parseFloat(document.getElementById("dcf-crescimento").value) / 100;
  const taxaDesconto = parseFloat(document.getElementById("dcf-desconto").value) / 100;
  const horizonte = parseInt(document.getElementById("dcf-horizonte").value);
  const precoAtual = parseFloat(document.getElementById("dcf-preco-atual").value);

  if (isNaN(dividendoMensal) || dividendoMensal <= 0) {
    alert("Informe o dividendo mensal atual.");
    return;
  }
  if (isNaN(crescimentoAnual)) {
    alert("Informe a taxa de crescimento anual.");
    return;
  }
  if (isNaN(taxaDesconto) || taxaDesconto <= 0) {
    alert("Informe a taxa de desconto anual.");
    return;
  }
  if (isNaN(horizonte) || horizonte < 1) {
    alert("Informe o horizonte de análise.");
    return;
  }
  if (taxaDesconto <= crescimentoAnual) {
    alert("A taxa de desconto deve ser maior que a taxa de crescimento para o modelo ser válido.");
    return;
  }

  const dividendoAnual0 = dividendoMensal * 12;

  // VP dos dividendos no horizonte
  let vpDividendos = 0;
  let dividendoAno = dividendoAnual0;
  for (let t = 1; t <= horizonte; t++) {
    dividendoAno = dividendoAnual0 * Math.pow(1 + crescimentoAnual, t);
    vpDividendos += dividendoAno / Math.pow(1 + taxaDesconto, t);
  }

  // Valor terminal (Gordon Growth Model no horizonte N)
  const dividendoN1 = dividendoAnual0 * Math.pow(1 + crescimentoAnual, horizonte + 1);
  const valorTerminal = dividendoN1 / (taxaDesconto - crescimentoAnual);
  const vpTerminal = valorTerminal / Math.pow(1 + taxaDesconto, horizonte);

  const precoJusto = vpDividendos + vpTerminal;

  // Exibir resultados
  document.getElementById("dcf-preco-justo").textContent = formatarReais(precoJusto);
  document.getElementById("dcf-vp-dividendos").textContent = formatarReais(vpDividendos);
  document.getElementById("dcf-vp-terminal").textContent = formatarReais(vpTerminal);

  // Upside/downside se preço atual informado
  const upsideBloco = document.getElementById("dcf-upside-bloco");
  if (!isNaN(precoAtual) && precoAtual > 0) {
    const upside = (precoJusto - precoAtual) / precoAtual * 100;
    const sinal = upside >= 0 ? "+" : "";
    const el = document.getElementById("dcf-upside");
    el.textContent = sinal + upside.toFixed(1) + "%";
    el.style.color = upside >= 0 ? "var(--verde)" : "var(--vermelho)";
    upsideBloco.style.display = "block";
  } else {
    upsideBloco.style.display = "none";
  }

  document.getElementById("dcf-resultado").style.display = "block";
}

function formatarReais(valor) {
  return "R$ " + valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
