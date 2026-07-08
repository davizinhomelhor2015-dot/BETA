// ════════════════════════════════════════════════════════════════════
// Script rodado pelo GitHub Actions (.github/workflows/backup-cron.yml)
// a cada 15 minutos.
//
// LÓGICA DE DIAS:
//   O admin escolhe QUAIS DIAS da semana o backup roda por setor.
//   Ex: "quinta e sábado" → o backup de quinta salva os dados de
//   quarta pra trás (até o backup anterior), e o de sábado salva
//   quinta+sexta. O período salvo é sempre o intervalo ENTRE dois
//   dias de backup consecutivos.
//
// GARANTIA DE SALVAMENTO:
//   - Marca no Firebase que o setor já foi feito hoje (evita duplicar).
//   - Se o GitHub Actions falhar por qualquer motivo, na próxima
//     execução (15 min depois) tenta de novo.
//   - Salva os arquivos no repositório via commit automático.
// ════════════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const BASE = process.env.FIREBASE_BASE_PATH || "efetivo_novo";

// ── helpers Firebase (REST público — sem senha, igual ao site) ──────
async function fbGet(caminho) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${caminho} → ${r.status}`);
  return r.json();
}
async function fbPatch(caminho, valor) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`, {
    method: "PATCH", body: JSON.stringify(valor),
    headers: { "Content-Type": "application/json" }
  });
  if (!r.ok) throw new Error(`Firebase PATCH ${caminho} → ${r.status}`);
  return r.json();
}
async function fbDelete(caminho) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`Firebase DELETE ${caminho} → ${r.status}`);
}

// ── datas ────────────────────────────────────────────────────────────
const DOW_NOMES = ["DOMINGO","SEGUNDA","TERÇA","QUARTA","QUINTA","SEXTA","SÁBADO"];

function isoDate(d) {
  return d.getUTCFullYear() + "-"
    + String(d.getUTCMonth() + 1).padStart(2, "0") + "-"
    + String(d.getUTCDate()).padStart(2, "0");
}

// Dado um array de dias escolhidos (ex: [4, 6] = quinta e sábado) e
// a data de HOJE (dia de backup), calcula o PERÍODO que este backup
// deve cobrir: do dia seguinte ao backup anterior até ONTEM.
//
// Exemplo: dias=[1,4,6], hoje=quinta(4)
//   → backup anterior = segunda(1)
//   → período: terça, quarta (os dias entre segunda e quinta)
//
// Se só há 1 dia marcado, salva os 7 dias anteriores.
function periodoBackup(diasConfig, hoje) {
  const dias = [...new Set(diasConfig.map(Number))].sort((a,b)=>a-b);
  if (!dias.length) return null;

  const dow = hoje.getUTCDay(); // dia da semana de hoje (0=dom..6=sab)

  // Acha o índice do dia atual dentro da lista de dias configurados
  const idxAtual = dias.indexOf(dow);
  if (idxAtual === -1) return null; // hoje não é dia de backup

  // Dia de backup ANTERIOR (com wrap: se hoje é o primeiro da lista,
  // o anterior é o último da semana passada)
  const dowAnterior = idxAtual === 0
    ? dias[dias.length - 1]
    : dias[idxAtual - 1];

  // Quantos dias atrás foi esse backup anterior?
  let diasAtras = dow - dowAnterior;
  if (diasAtras <= 0) diasAtras += 7;

  // O período começa no dia APÓS o backup anterior e vai até ONTEM
  const inicio = new Date(hoje.getTime() - (diasAtras - 1) * 86400000);
  const fim    = new Date(hoje.getTime() - 86400000); // ontem

  // Monta array de datas do período
  const datas = [];
  for (let d = new Date(inicio); d <= fim; d = new Date(d.getTime() + 86400000)) {
    datas.push({
      nome: DOW_NOMES[d.getUTCDay()],
      data: isoDate(d)
    });
  }

  return datas.length ? datas : null;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  if (!FIREBASE_DB_URL) throw new Error("FIREBASE_DB_URL não definida");

  // Horário de Brasília (UTC-3)
  const agoraUTC  = new Date();
  const agora     = new Date(agoraUTC.getTime() - 3 * 60 * 60 * 1000);
  const horaAtual = agora.getUTCHours();
  const minAtual  = agora.getUTCMinutes();
  const slotHoje  = isoDate(agora);

  console.log(`\n🕐 Hora atual (Brasília): ${horaAtual}:${String(minAtual).padStart(2,"0")} — ${DOW_NOMES[agora.getUTCDay()]}\n`);

  // Busca configs de todos os setores + dados + índice de já feitos
  const [cfgs, unidades, jaFeitos] = await Promise.all([
    fbGet("config/backup_auto"),
    fbGet(BASE + "/unidades"),
    fbGet(BASE + "_backups_auto_setor")
  ]);

  let algumProcessado = false;

  for (const [setor, cfg] of Object.entries(cfgs || {})) {
   try {
    if (!cfg || !cfg.ativo) {
      console.log(`⏭  ${setor}: inativo — pulando`);
      continue;
    }

    const dias = Array.isArray(cfg.dias) ? cfg.dias.map(Number) : [];
    if (!dias.includes(agora.getUTCDay())) {
      console.log(`⏭  ${setor}: hoje (${DOW_NOMES[agora.getUTCDay()]}) não é dia de backup — pulando`);
      continue;
    }

    const [hh, mm] = String(cfg.hora || "11:00").split(":").map(n => parseInt(n, 10) || 0);
    if (horaAtual < hh || (horaAtual === hh && minAtual < mm)) {
      console.log(`⏭  ${setor}: horário ainda não chegou (configurado: ${hh}:${String(mm).padStart(2,"0")}) — pulando`);
      continue;
    }

    // Já foi feito hoje?
    if (jaFeitos?.[setor]?.[slotHoje]?.ok) {
      console.log(`✅ ${setor}: backup de hoje já foi feito — pulando`);
      continue;
    }

    // Calcula o período que este backup cobre
    const periodo = periodoBackup(dias, agora);
    if (!periodo || !periodo.length) {
      console.log(`⚠️  ${setor}: não foi possível calcular o período — pulando`);
      continue;
    }

    const datasDoBloco = new Set(periodo.map(p => p.data));
    const dataInicio   = periodo[0].data;
    const dataFim      = periodo[periodo.length - 1].data;
    const periodoLabel = periodo.length === 1
      ? `${periodo[0].nome} (${periodo[0].data})`
      : `${periodo[0].nome} a ${periodo[periodo.length-1].nome} (${dataInicio} a ${dataFim})`;

    console.log(`🔄 ${setor}: processando backup — período: ${periodoLabel}`);

    const dadosSetor    = (unidades && unidades[setor]) || {};
    const efetivo       = dadosSetor.efetivo || {};
    const fotosPorDia   = dadosSetor.fotos_pendentes || {};
    const totalNomes    = Object.keys(efetivo).length;

    // Conta fotos apenas dentro do período
    let totalFotos = 0;
    Object.entries(fotosPorDia).forEach(([diaKey, dia]) => {
      if (datasDoBloco.has(diaKey)) totalFotos += Object.keys(dia || {}).length;
    });

    // Cria pasta e salva dados.json
    const pastaBase = path.join("backups", setor, dataInicio);
    fs.mkdirSync(pastaBase, { recursive: true });

    fs.writeFileSync(path.join(pastaBase, "dados.json"), JSON.stringify({
      setor, dataReferencia: dataInicio, dataReferenciaFim: dataFim,
      diasCobertos: periodo,
      periodoLabel,
      totalNomes, totalFotos,
      efetivo,
      geradoEm: agoraUTC.toISOString()
    }, null, 2));

    // Salva fotos (decodifica base64 → arquivo de imagem)
    let erro = null;
    try {
      const pastaFotos = path.join(pastaBase, "fotos");
      let temFoto = false;
      for (const [diaKey, fotosDoDia] of Object.entries(fotosPorDia)) {
        if (!datasDoBloco.has(diaKey)) continue;
        for (const [fotoId, fotoObj] of Object.entries(fotosDoDia || {})) {
          const dataUrl = fotoObj && typeof fotoObj === "object" ? fotoObj.img : fotoObj;
          const m = String(dataUrl || "").match(/^data:image\/(\w+);base64,(.+)$/);
          if (!m) continue;
          if (!temFoto) { fs.mkdirSync(pastaFotos, { recursive: true }); temFoto = true; }
          fs.writeFileSync(path.join(pastaFotos, `${diaKey}_${fotoId}.${m[1]}`), Buffer.from(m[2], "base64"));
        }
      }
    } catch (e) {
      erro = e.message;
      console.error(`⚠️  ${setor}: erro ao salvar fotos: ${e.message}`);
    }

    // Apaga as fotos do período no Firebase (já estão no backup)
    if (!erro) {
      for (const diaKey of datasDoBloco) {
        if (fotosPorDia[diaKey]) {
          try {
            await fbDelete(BASE + "/unidades/" + setor + "/fotos_pendentes/" + diaKey);
          } catch (e) {
            console.warn(`⚠️  ${setor}: não conseguiu apagar fotos do dia ${diaKey}: ${e.message}`);
          }
        }
      }
    }

    if (!erro) {
      // Sucesso: marca como feito no Firebase (índice leve para o painel
      // mostrar). Só a partir daqui é que a próxima execução vai pular
      // este setor — se não marcarmos, ele tenta de novo em 15 min.
      await fbPatch(BASE + "_backups_auto_setor/" + setor, {
        [slotHoje]: {
          ok: true, erro: null,
          dataReferencia: dataInicio, dataReferenciaFim: dataFim,
          periodoLabel, totalNomes, totalFotos,
          caminho: `backups/${setor}/${dataInicio}`,
          criadoEm: agoraUTC.toISOString()
        }
      });

      // Retenção: remove entradas antigas do índice (só corre quando deu certo)
      try {
        const manter = Math.max(1, parseInt(cfg.manter, 10) || 12);
        const idxAtual = { ...(jaFeitos?.[setor] || {}), [slotHoje]: true };
        const chaves = Object.keys(idxAtual).sort();
        const excedentes = chaves.slice(0, Math.max(0, chaves.length - manter));
        for (const k of excedentes) {
          await fbDelete(BASE + "_backups_auto_setor/" + setor + "/" + k);
        }
      } catch (e) { /* retenção é best-effort */ }

      algumProcessado = true;
      console.log(`✅ ${setor}: ${totalNomes} nomes, ${totalFotos} fotos — referente a ${periodoLabel}`);
    } else {
      // ERRO: de propósito NÃO grava em jaFeitos[setor][slotHoje].
      // Assim, na próxima execução (15 min depois), este setor não vai
      // estar marcado como "já feito" e o script vai tentar de novo,
      // até dar certo. Só registramos o erro num campo separado, que
      // não bloqueia a próxima tentativa, só pra dar visibilidade.
      try {
        await fbPatch(BASE + "_backups_auto_setor/" + setor, {
          _ultimaTentativaComErro: {
            slot: slotHoje, erro, periodoLabel,
            tentadoEm: agoraUTC.toISOString()
          }
        });
      } catch (e) { /* mesmo se isso falhar, a retentativa ainda acontece */ }

      algumProcessado = true;
      console.error(`❌ ${setor}: falhou (${erro}) — NÃO marcado como concluído, vai tentar de novo na próxima execução (até 15 min).`);
    }
   } catch (e) {
    // Qualquer erro inesperado neste setor (ex: falha de rede no Firebase)
    // NÃO derruba o script inteiro — os outros setores continuam sendo
    // processados normalmente, e este setor será tentado de novo em 15 min
    // (porque não foi marcado como concluído).
    console.error(`❌ ${setor}: erro inesperado — ${e.message} — será tentado de novo na próxima execução.`);
   }
  }

  if (!algumProcessado) {
    console.log("\nNenhum setor com horário batendo agora — nada a fazer.");
  }
}

main().catch(e => { console.error("Erro fatal no backup:", e); process.exit(1); });
