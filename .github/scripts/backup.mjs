// ════════════════════════════════════════════════════════════════════
// Script rodado pelo GitHub Actions (.github/workflows/backup-cron.yml).
// Lê o Firebase (público, sem senha — mesmo banco que o site usa) e
// escreve os arquivos de backup DENTRO deste repositório (o workflow que
// chamou este script é quem depois faz o commit/push, usando o token
// automático do GitHub Actions).
// ════════════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const BASE = process.env.FIREBASE_BASE_PATH || "efetivo_novo";
const DIA_NOMES = ["domingo","segunda","terça","quarta","quinta","sexta","sábado"];

async function fbGet(caminho) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`);
  if (!r.ok) throw new Error(`Firebase GET ${caminho} falhou: ${r.status}`);
  return r.json();
}
async function fbPatch(caminho, valor) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`, { method: "PATCH", body: JSON.stringify(valor) });
  if (!r.ok) throw new Error(`Firebase PATCH ${caminho} falhou: ${r.status}`);
  return r.json();
}
async function fbDelete(caminho) {
  const r = await fetch(`${FIREBASE_DB_URL}/${caminho}.json`, { method: "DELETE" });
  if (!r.ok) throw new Error(`Firebase DELETE ${caminho} falhou: ${r.status}`);
}

function slotDoDia(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}

// Mesma lógica de "bloco de dias" usada na Lista de Presença do site:
// Seg-Ter-Qua = 1 bloco (3 dias) · Qui-Sex = 1 bloco (2 dias) · Sáb-Dom =
// 1 bloco (2 dias). Passando a data de ONTEM, devolve o bloco INTEIRO que
// acabou de terminar — é exatamente o período que cada backup deve cobrir:
//   backup de quinta → bloco seg/ter/qua · backup de sábado → bloco qui/sex
//   backup de segunda → bloco sáb/dom
function blocoDoDia(baseDate) {
  const dow = baseDate.getUTCDay();
  let startOffset, nomes;
  if (dow >= 1 && dow <= 3) { startOffset = -(dow - 1); nomes = ["SEGUNDA", "TERÇA", "QUARTA"]; }
  else if (dow >= 4 && dow <= 5) { startOffset = -(dow - 4); nomes = ["QUINTA", "SEXTA"]; }
  else if (dow === 6) { startOffset = 0; nomes = ["SÁBADO", "DOMINGO"]; }
  else { startOffset = -1; nomes = ["SÁBADO", "DOMINGO"]; }
  return nomes.map((nome, i) => {
    const dt = new Date(baseDate.getTime() + (startOffset + i) * 24 * 60 * 60 * 1000);
    return { nome, data: slotDoDia(dt) };
  });
}

async function main() {
  if (!FIREBASE_DB_URL) throw new Error("FIREBASE_DB_URL não definida");

  // Fuso de Brasília (UTC-3) — os horários configurados no painel são
  // sempre no horário local do Brasil
  const agoraUTC = new Date();
  const agora = new Date(agoraUTC.getTime() - 3 * 60 * 60 * 1000);
  const diaSemana = agora.getUTCDay();
  const horaAtual = agora.getUTCHours();
  const minutoAtual = agora.getUTCMinutes();
  const ontem = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
  const slotHoje = slotDoDia(agora);

  const [cfgs, unidades, jaFeitos] = await Promise.all([
    fbGet("config/backup_auto"),
    fbGet(BASE + "/unidades"),
    fbGet(BASE + "_backups_auto_setor")
  ]);

  let algumProcessado = false;

  for (const [setor, cfg] of Object.entries(cfgs || {})) {
    if (!cfg || !cfg.ativo) continue;
    const dias = Array.isArray(cfg.dias) ? cfg.dias.map(Number) : [];
    if (!dias.includes(diaSemana)) continue;
    const [hh, mm] = String(cfg.hora || "11:00").split(":").map(n => parseInt(n, 10) || 0);
    if (horaAtual < hh || (horaAtual === hh && minutoAtual < mm)) continue;

    const jaFeitoHoje = jaFeitos && jaFeitos[setor] && jaFeitos[setor][slotHoje];
    if (jaFeitoHoje) continue;

    console.log(`Processando backup de ${setor}...`);
    const dadosSetor = (unidades && unidades[setor]) || {};
    const efetivo = dadosSetor.efetivo || {};
    const fotosPorDia = dadosSetor.fotos_pendentes || {};

    // Período coberto por este backup = o BLOCO INTEIRO que acabou de
    // terminar (ex: backup de quinta cobre segunda+terça+quarta)
    const bloco = blocoDoDia(ontem);
    const dataRef = bloco[0].data; // pasta nomeada pelo primeiro dia do bloco
    const dataRefFim = bloco[bloco.length - 1].data;
    const periodoLabel = bloco.length > 1 ? `${bloco[0].nome} a ${bloco[bloco.length - 1].nome} (${bloco[0].data} a ${bloco[bloco.length - 1].data})` : `${bloco[0].nome} (${bloco[0].data})`;
    const datasDoBloco = new Set(bloco.map(b => b.data));

    // Só conta fotos que realmente estão DENTRO do período deste backup
    let totalFotos = 0;
    Object.entries(fotosPorDia).forEach(([diaKey, dia]) => { if (datasDoBloco.has(diaKey)) totalFotos += Object.keys(dia || {}).length; });

    const pastaBase = path.join("backups", setor, dataRef);
    fs.mkdirSync(pastaBase, { recursive: true });

    // dados.json
    fs.writeFileSync(path.join(pastaBase, "dados.json"), JSON.stringify({
      setor, dataReferencia: dataRef, dataReferenciaFim: dataRefFim,
      diasCobertos: bloco.map(b => ({ nome: b.nome, data: b.data })),
      periodoLabel,
      totalNomes: Object.keys(efetivo).length,
      totalFotos, efetivo, geradoEm: agoraUTC.toISOString()
    }, null, 2));

    // fotos (decodifica o base64 de volta pra arquivo de imagem de verdade)
    // Estrutura real: fotos_pendentes/<dia>/<id> = { img: "data:image/...;base64,XXXX", enviadoPor, enviadoEm }
    let erro = null;
    try {
      const pastaFotos = path.join(pastaBase, "fotos");
      let temFoto = false;
      for (const [diaKey, fotosDoDia] of Object.entries(fotosPorDia)) {
        if (!datasDoBloco.has(diaKey)) continue; // fora do período deste backup — ignora
        for (const [fotoId, fotoObj] of Object.entries(fotosDoDia || {})) {
          const dataUrl = fotoObj && typeof fotoObj === "object" ? fotoObj.img : fotoObj; // aceita os dois formatos, por segurança
          const m = String(dataUrl || "").match(/^data:image\/(\w+);base64,(.+)$/);
          if (!m) continue;
          if (!temFoto) { fs.mkdirSync(pastaFotos, { recursive: true }); temFoto = true; }
          fs.writeFileSync(path.join(pastaFotos, `${diaKey}_${fotoId}.${m[1]}`), Buffer.from(m[2], "base64"));
        }
      }
    } catch (e) { erro = e.message; }

    // Depois de salvar com sucesso, apaga as fotos do "Fotos do Dia" — elas
    // ficam só no backup a partir de agora, sem duplicar em dois lugares
    if (!erro) {
      for (const diaKey of datasDoBloco) {
        if (fotosPorDia[diaKey]) {
          try { await fbDelete(BASE + "/unidades/" + setor + "/fotos_pendentes/" + diaKey); } catch (e) { /* não impede o backup de ter dado certo */ }
        }
      }
    }

    // Marca como feito hoje (evita duplicar) + índice leve pro painel mostrar
    await fbPatch(BASE + "_backups_auto_setor/" + setor, {
      [slotHoje]: {
        ok: !erro, erro: erro || null, dataReferencia: dataRef, dataReferenciaFim: dataRefFim, periodoLabel,
        totalNomes: Object.keys(efetivo).length, totalFotos,
        caminho: `backups/${setor}/${dataRef}`, criadoEm: agoraUTC.toISOString()
      }
    });

    // Retenção: mantém só os últimos N registros do índice
    try {
      const idxAtual = { ...(jaFeitos && jaFeitos[setor]), [slotHoje]: true };
      const manter = Math.max(1, parseInt(cfg.manter, 10) || 12);
      const chaves = Object.keys(idxAtual).sort();
      const excedentes = chaves.slice(0, Math.max(0, chaves.length - manter));
      for (const k of excedentes) {
        await fbDelete(BASE + "_backups_auto_setor/" + setor + "/" + k);
      }
    } catch (e) { /* retenção é best-effort */ }

    algumProcessado = true;
    console.log(`✅ ${setor}: ${Object.keys(efetivo).length} nomes, ${totalFotos} fotos, referente a ${dataRef}`);
  }

  if (!algumProcessado) console.log("Nenhum setor com horário batendo agora — nada a fazer nesta execução.");
}

main().catch(e => { console.error("Erro no backup:", e); process.exit(1); });
