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

// 100% AUTOMÁTICO — descobre sozinho quantos dias cobrir, olhando pra
// quando foi o ÚLTIMO dia programado pra rodar (o campo "dias" que já
// existe, o mesmo que decide QUANDO o backup roda). Não precisa marcar
// nada a mais: se os dias programados são Segunda/Quinta/Sábado, o backup
// de quinta automaticamente cobre segunda+terça+quarta (o intervalo desde
// o último dia programado), o de sábado cobre quinta+sexta, etc. Se os
// dias programados forem TODOS os 7 dias, cada backup cobre só o dia
// anterior (ex: backup de terça cobre só segunda).
function diasCobertosAutomatico(hojeDow, diasGatilho) {
  if (!diasGatilho || !diasGatilho.length) return [(hojeDow + 6) % 7]; // sem gatilho configurado: cobre só ontem

  // Acha o menor "intervalo" até um gatilho anterior (nunca conta hoje
  // mesmo se hoje também for um dia gatilho — sempre olha pro ANTERIOR)
  let menorIntervalo = 7;
  for (const g of diasGatilho) {
    let diasAtras = (hojeDow - g + 7) % 7;
    if (diasAtras === 0) diasAtras = 7;
    if (diasAtras < menorIntervalo) menorIntervalo = diasAtras;
  }
  // Cobre os "menorIntervalo" dias imediatamente antes de hoje, em ordem
  const dias = [];
  for (let i = menorIntervalo; i >= 1; i--) dias.push((hojeDow - i + 7) % 7);
  return dias;
}

function blocoDoDia(baseDate, diasGatilho) {
  const DIA_NOMES_FULL = ["DOMINGO", "SEGUNDA", "TERÇA", "QUARTA", "QUINTA", "SEXTA", "SÁBADO"];
  // baseDate aqui é "hoje" (o dia em que o backup está rodando de verdade,
  // não mais "ontem" — precisamos saber o dia de HOJE pra achar o gatilho
  // anterior corretamente)
  const hojeDow = baseDate.getUTCDay();
  const dias = diasCobertosAutomatico(hojeDow, diasGatilho);

  return dias
    .map(diaAlvo => {
      const diasAtras = (hojeDow - diaAlvo + 7) % 7;
      const dt = new Date(baseDate.getTime() - diasAtras * 24 * 60 * 60 * 1000);
      return { nome: DIA_NOMES_FULL[diaAlvo], data: slotDoDia(dt), _ord: dt.getTime() };
    })
    .sort((a, b) => a._ord - b._ord)
    .map(({ nome, data }) => ({ nome, data }));
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

    // Período coberto por este backup
    // Modo "diario": cobre sempre só o dia anterior (1 dia)
    // Modo "combo" (padrão): cobre o bloco inteiro desde o último gatilho
    const bloco = cfg.modo === "diario"
      ? [(() => {
          const ontem = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
          const DIA_NOMES_FULL = ["DOMINGO","SEGUNDA","TERÇA","QUARTA","QUINTA","SEXTA","SÁBADO"];
          return { nome: DIA_NOMES_FULL[ontem.getUTCDay()], data: slotDoDia(ontem) };
        })()]
      : blocoDoDia(agora, cfg.dias);
    const dataRef = bloco[0].data; // pasta nomeada pelo primeiro dia do bloco
    const dataRefFim = bloco[bloco.length - 1].data;
    const periodoLabel = bloco.length > 1 ? `${bloco[0].nome} a ${bloco[bloco.length - 1].nome} (${bloco[0].data} a ${bloco[bloco.length - 1].data})` : `${bloco[0].nome} (${bloco[0].data})`;
    const datasDoBloco = new Set(bloco.map(b => b.data));

    // FOTOS: varre TODAS as fotos pendentes até hoje (não só as do bloco).
    // As "fotos do dia" existem justamente pra irem pro backup e serem
    // apagadas — então pegar tudo que está pendente garante que nenhuma
    // foto fique pra trás, mesmo que um backup tenha falhado em algum dia
    // ou que a foto seja do próprio dia em que o backup roda.
    const ehDataValida = k => /^\d{4}-\d{2}-\d{2}$/.test(k);
    const diasFotos = new Set(
      Object.keys(fotosPorDia).filter(k => ehDataValida(k) && k <= slotHoje)
    );

    let totalFotos = 0;
    diasFotos.forEach(diaKey => { totalFotos += Object.keys(fotosPorDia[diaKey] || {}).length; });

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
      const meta = {}; // nomeArquivo -> { por, em, dia, atrasada } — quem enviou, quando, e se é de um dia anterior ao período deste backup
      for (const [diaKey, fotosDoDia] of Object.entries(fotosPorDia)) {
        if (!diasFotos.has(diaKey)) continue; // não é um dia de foto pendente válido — ignora
        const atrasada = !datasDoBloco.has(diaKey); // foto de um dia FORA do período deste backup (sobrou de antes)
        for (const [fotoId, fotoObj] of Object.entries(fotosDoDia || {})) {
          const ehObj = fotoObj && typeof fotoObj === "object";
          const dataUrl = ehObj ? fotoObj.img : fotoObj; // aceita os dois formatos, por segurança
          const m = String(dataUrl || "").match(/^data:image\/(\w+);base64,(.+)$/);
          if (!m) continue;
          if (!temFoto) { fs.mkdirSync(pastaFotos, { recursive: true }); temFoto = true; }
          const nomeArquivo = `${diaKey}_${fotoId}.${m[1]}`;
          fs.writeFileSync(path.join(pastaFotos, nomeArquivo), Buffer.from(m[2], "base64"));
          meta[nomeArquivo] = { por: (ehObj && fotoObj.enviadoPor) || "—", em: (ehObj && fotoObj.enviadoEm) || null, dia: diaKey, atrasada };
        }
      }
      // Guarda quem enviou cada foto e quando, pra o painel conseguir mostrar.
      // (Backups antigos não têm esse arquivo — o painel lida com a ausência.)
      if (temFoto) fs.writeFileSync(path.join(pastaFotos, "_meta.json"), JSON.stringify(meta, null, 2));
    } catch (e) { erro = e.message; }

    // Depois de salvar com sucesso, apaga as fotos do "Fotos do Dia" — elas
    // ficam só no backup a partir de agora, sem duplicar em dois lugares
    if (!erro) {
      for (const diaKey of diasFotos) {
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
