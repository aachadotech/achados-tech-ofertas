// =====================================================================
// ACHADOS TECH - Ofertas do Mercado Livre -> Telegram (GitHub Actions)
// =====================================================================
// Roda a cada 20 min pelo GitHub Actions (.github/workflows/ofertas.yml).
// Faz o mesmo que o workflow do n8n:
//   1. Renova o acesso à API do Mercado Livre (refresh_token rotativo)
//   2. Busca os mais vendidos: placas de vídeo + 1 componente + 1 periférico
//   3. Escolhe até 3 ofertas novas (1 placa de vídeo garantida, promoções primeiro)
//   4. Posta no Telegram com o link de afiliado escondido
//
// O "estado" (token + histórico de postados + rodízio) fica no arquivo
// estado.enc, CRIPTOGRAFADO com a senha do secret ESTADO_SENHA, e é
// guardado no branch "estado" do repositório.
// =====================================================================

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

// ---------------- CONFIGURAÇÃO ----------------
const CONFIG = {
  MATT_WORD: process.env.ML_MATT_WORD || 'at20260922203101885',
  MATT_TOOL: process.env.ML_MATT_TOOL || '41829093',

  PRODUTOS_POR_CATEGORIA: 50,
  VAGAS_PLACA_DE_VIDEO: 1,  // posts reservados para placa de vídeo em cada rodada (se houver)
  DESCONTO_MINIMO: 10,       // % mínimo para contar como promoção
  LIMITE_POSTS: 3,           // posts por execução
  DIAS_SEM_REPETIR: 7,       // não repete o mesmo produto por X dias...
  QUEDA_PARA_REPOSTAR: 5,    // ...a menos que o preço caia X% ou mais
  DIAS_DE_HISTORICO: 30,
  TAMANHO_MAX_NOME: 45,
  REQUISICOES_SIMULTANEAS: 8
};

// Cada rodada olha: placas de vídeo (sempre) + 1 componente + 1 periférico/setup
const PLACAS_DE_VIDEO = { id: 'MLB1658', nome: 'Placas de vídeo' };

const COMPONENTES = [
  { id: 'MLB1693', nome: 'Processadores' },
  { id: 'MLB1692', nome: 'Placas-mãe' },
  { id: 'MLB1694', nome: 'Memórias RAM' },
  { id: 'MLB430598', nome: 'SSDs e armazenamento' },
  { id: 'MLB430916', nome: 'Fontes' },
  { id: 'MLB438783', nome: 'Gabinetes' },
  { id: 'MLB430788', nome: 'Refrigeração' }
];

const PERIFERICOS = [
  { id: 'MLB99245', nome: 'Monitores' },
  { id: 'MLB418472', nome: 'Teclados' },
  { id: 'MLB1714', nome: 'Mouses' },
  { id: 'MLB1664', nome: 'Headsets' },
  { id: 'MLB447782', nome: 'Cadeiras gamer' },
  { id: 'MLB1716', nome: 'Mousepads' },
  { id: 'MLB439418', nome: 'Mesas para PC' },
  { id: 'MLB1672', nome: 'HDs e SSDs externos' },
  { id: 'MLB73364', nome: 'Webcams' },
  { id: 'MLB8279', nome: 'Microfones' },
  { id: 'MLB418047', nome: 'Suportes de monitor' },
  { id: 'MLB1659', nome: 'Placas de captura' },
  { id: 'MLB11187', nome: 'Hubs USB' },
  { id: 'MLB5867', nome: 'Roteadores' },
  { id: 'MLB270504', nome: 'No-breaks' },
  { id: 'MLB3378', nome: 'Caixas de som' },
  { id: 'MLB189908', nome: 'Fitas de LED' },
  { id: 'MLB456571', nome: 'Suportes para headset' },
  { id: 'MLB4980', nome: 'Pen drives' }
];

const BLOQUEADAS = [
  'notebook', 'laptop', 'chromebook', 'macbook', 'celular', 'smartphone', 'iphone',
  'tablet', 'ipad', 'smart tv', 'usado', 'usada', 'recondicionado', 'recondicionada',
  'defeito', 'sucata', 'retirada de peças', 'gift card', 'cartão presente'
];

// ---------------- AMBIENTE ----------------
const ENV = {
  CLIENT_ID: process.env.ML_CLIENT_ID || '1477611169283374',
  CLIENT_SECRET: process.env.ML_CLIENT_SECRET,
  REFRESH_TOKEN_INICIAL: (process.env.ML_REFRESH_TOKEN || '').trim(),
  TG_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TG_CHAT: process.env.TELEGRAM_CHAT_ID,
  SENHA: process.env.ESTADO_SENHA,
  TESTE: /^(1|true|sim)$/i.test(process.env.MODO_TESTE || ''),
  ARQ_ESTADO: process.env.ARQUIVO_ESTADO || 'estado.enc',
  API: process.env.ML_API_URL || 'https://api.mercadolibre.com',
  TG_API: process.env.TELEGRAM_API_URL || 'https://api.telegram.org'
};

const DIA = 24 * 60 * 60 * 1000;
const agora = Date.now();

function falhar(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}
function mascarar(valor) {
  if (valor && process.env.GITHUB_ACTIONS) console.log('::add-mask::' + valor);
}

// ---------------- ESTADO CRIPTOGRAFADO ----------------
function chave() {
  return crypto.scryptSync(ENV.SENHA, 'achadostech-estado-v1', 32);
}
function lerEstado() {
  if (!fs.existsSync(ENV.ARQ_ESTADO)) return null;
  const bruto = Buffer.from(fs.readFileSync(ENV.ARQ_ESTADO, 'utf8').trim(), 'base64');
  const iv = bruto.subarray(0, 12);
  const tag = bruto.subarray(12, 28);
  const dados = bruto.subarray(28);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
    d.setAuthTag(tag);
    const json = zlib.gunzipSync(Buffer.concat([d.update(dados), d.final()])).toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    falhar('Não consegui abrir o estado.enc. O secret ESTADO_SENHA mudou? Volte a senha antiga.');
  }
}
function salvarEstado(estado) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const cifrado = Buffer.concat([c.update(zlib.gzipSync(JSON.stringify(estado))), c.final()]);
  const saida = Buffer.concat([iv, c.getAuthTag(), cifrado]).toString('base64');
  fs.writeFileSync(ENV.ARQ_ESTADO + '.tmp', saida);
  fs.renameSync(ENV.ARQ_ESTADO + '.tmp', ENV.ARQ_ESTADO);
}

// ---------------- HTTP ----------------
async function getJson(url, token) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (tentativa === 2) return null;
      await new Promise(res => setTimeout(res, 800));
    }
  }
}

async function emParalelo(lista, limite, fn) {
  const saida = new Array(lista.length);
  let i = 0;
  async function trabalhador() {
    while (i < lista.length) {
      const atual = i++;
      saida[atual] = await fn(lista[atual], atual);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, trabalhador));
  return saida;
}

// ---------------- 1. TOKEN ----------------
async function renovar(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ENV.CLIENT_ID,
    client_secret: ENV.CLIENT_SECRET,
    refresh_token: refreshToken
  });
  const r = await fetch(ENV.API + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20000)
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok || !dados.access_token) {
    throw new Error(`HTTP ${r.status}: ${dados.message || dados.error || 'erro'}`);
  }
  return dados;
}

async function obterToken(estado) {
  if (estado.access_token && Number(estado.expira_em) > agora + 15 * 60 * 1000) {
    mascarar(estado.access_token);
    return estado.access_token;
  }
  const tentativas = [];
  if (estado.refresh_token) tentativas.push(estado.refresh_token);
  if (ENV.REFRESH_TOKEN_INICIAL && !tentativas.includes(ENV.REFRESH_TOKEN_INICIAL)) {
    tentativas.push(ENV.REFRESH_TOKEN_INICIAL);
  }
  if (!tentativas.length) falhar('Falta o secret ML_REFRESH_TOKEN (primeira execução).');

  const erros = [];
  for (const rt of tentativas) {
    try {
      const d = await renovar(rt);
      mascarar(d.access_token);
      mascarar(d.refresh_token);
      estado.access_token = d.access_token;
      estado.refresh_token = d.refresh_token;
      estado.expira_em = agora + (Number(d.expires_in) || 21600) * 1000;
      salvarEstado(estado); // grava já: o refresh_token antigo deixou de valer
      console.log('Token do Mercado Livre renovado.');
      return d.access_token;
    } catch (e) {
      erros.push(e.message);
    }
  }
  falhar('Não consegui renovar o acesso ao Mercado Livre (' + erros.join(' | ') + '). ' +
    'Faça a autorização de novo e coloque o refresh_token novo no secret ML_REFRESH_TOKEN.');
}

// ---------------- 2. BUSCA ----------------
const L = 'a-z0-9à-ÿ';
const regexBloq = BLOQUEADAS.map(p =>
  new RegExp(`(^|[^${L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^${L}])`, 'i'));
const bloqueado = nome => regexBloq.some(r => r.test(String(nome || '')));

function imagemJpg(url) {
  if (!url) return null;
  return String(url)
    .replace(/^http:/, 'https:')
    .replace(/-[A-Z]\.(webp|jpg|jpeg|png)(\?.*)?$/i, '-O.jpg')
    .replace(/\.webp(\?.*)?$/i, '.jpg');
}

async function detalhar(c, token) {
  if (c.type === 'PRODUCT') {
    const [p, itens] = await Promise.all([
      getJson(`${ENV.API}/products/${c.id}`, token),
      getJson(`${ENV.API}/products/${c.id}/items?limit=20`, token)
    ]);
    if (!p || !itens?.results?.length) return null;
    const novos = itens.results.filter(x => x.condition === 'new' && Number(x.price) > 0);
    if (!novos.length) return null;
    novos.sort((a, b) => a.price - b.price);
    const of = novos[0];
    return {
      id: c.id, nome: p.name, preco: of.price, preco_anterior: of.original_price,
      imagem: p.pictures?.[0]?.url,
      url: `https://www.mercadolivre.com.br/p/${c.id}?pdp_filters=item_id:${of.item_id}`
    };
  }
  if (c.type === 'ITEM') {
    const it = await getJson(`${ENV.API}/items/${c.id}`, token);
    if (!it || it.condition !== 'new' || it.status !== 'active') return null;
    return {
      id: c.id, nome: it.title, preco: it.price, preco_anterior: it.original_price,
      imagem: it.pictures?.[0]?.secure_url || it.pictures?.[0]?.url || it.thumbnail,
      url: (it.permalink || `https://produto.mercadolivre.com.br/${c.id}`).split('#')[0].split('?')[0]
    };
  }
  return null;
}

async function buscar(token, estado) {
  estado.rodada = (Number(estado.rodada) || 0) + 1;
  const escolhidas = [
    PLACAS_DE_VIDEO,
    COMPONENTES[estado.rodada % COMPONENTES.length],
    PERIFERICOS[estado.rodada % PERIFERICOS.length]
  ];
  console.log('Categorias desta rodada: ' + escolhidas.map(c => c.nome).join(', '));

  const produtos = [];
  const vistos = new Set();
  for (const cat of escolhidas) {
    const hl = await getJson(`${ENV.API}/highlights/MLB/category/${cat.id}`, token);
    const conteudo = (hl?.content || []).slice(0, CONFIG.PRODUTOS_POR_CATEGORIA);
    const detalhes = await emParalelo(conteudo, CONFIG.REQUISICOES_SIMULTANEAS, c => detalhar(c, token));

    for (const p of detalhes) {
      if (!p || !p.nome || !p.imagem) continue;
      if (vistos.has(p.id) || bloqueado(p.nome)) continue;
      vistos.add(p.id);
      const atual = Number(p.preco);
      let anterior = Number(p.preco_anterior);
      if (!(anterior > atual) || anterior > atual * 5) anterior = null;
      const desconto = anterior ? Math.round(((anterior - atual) / anterior) * 100) : 0;
      produtos.push({ ...p, preco: atual, preco_anterior: anterior, desconto, categoria: cat.nome, gpu: cat === PLACAS_DE_VIDEO,
        imagem: imagemJpg(p.imagem) });
    }
    console.log(`  ${cat.nome}: ${conteudo.length} mais vendidos olhados`);
  }
  return produtos;
}

// ---------------- 3. SELEÇÃO ----------------
function jaPostado(estado, id, preco) {
  const r = estado.postados[id];
  if (!r) return false;
  if (agora - r.data >= CONFIG.DIAS_SEM_REPETIR * DIA) return false;
  if (r.preco && preco && ((r.preco - preco) / r.preco) * 100 >= CONFIG.QUEDA_PARA_REPOSTAR) return false;
  return true;
}

function selecionar(produtos, estado) {
  const promocoes = [];
  const reservas = [];
  // Mesmo produto em anúncios diferentes (ex.: versões de console) conta como repetido
  const nomesVistos = new Map(Object.entries(estado.postados)
    .filter(([, r]) => r.nome && agora - r.data < CONFIG.DIAS_SEM_REPETIR * DIA)
    .map(([id, r]) => [r.nome, id]));
  for (const p of produtos) {
    if (jaPostado(estado, p.id, p.preco)) continue;
    const chaveNome = nomeCurto(p.nome).toLowerCase();
    if (nomesVistos.has(chaveNome) && nomesVistos.get(chaveNome) !== p.id) continue;
    nomesVistos.set(chaveNome, p.id);
    if (p.desconto >= CONFIG.DESCONTO_MINIMO && p.desconto < 95) promocoes.push(p);
    else reservas.push(p);
  }
  promocoes.sort((a, b) => b.desconto - a.desconto);
  reservas.sort((a, b) => b.desconto - a.desconto);
  const escolhidos = [];
  const usados = new Set();
  const pegar = (p, tipo) => { escolhidos.push({ ...p, tipo }); usados.add(p.id); };

  // 1. Vaga garantida para placa de vídeo (promoção primeiro, senão preço ótimo)
  const gpus = [...promocoes.filter(p => p.gpu).map(p => [p, 'promocao']),
                ...reservas.filter(p => p.gpu).map(p => [p, 'preco_otimo'])];
  for (const [p, tipo] of gpus.slice(0, CONFIG.VAGAS_PLACA_DE_VIDEO)) pegar(p, tipo);

  // 2. Resto: maiores descontos, depois preço ótimo
  for (const p of promocoes) {
    if (escolhidos.length >= CONFIG.LIMITE_POSTS) break;
    if (!usados.has(p.id)) pegar(p, 'promocao');
  }
  for (const p of reservas) {
    if (escolhidos.length >= CONFIG.LIMITE_POSTS) break;
    if (!usados.has(p.id)) pegar(p, 'preco_otimo');
  }
  return escolhidos;
}

// ---------------- 4. LEGENDA ----------------
const html = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function nomeCurto(nome) {
  nome = String(nome || '').replace(/\s+/g, ' ').trim();
  const corte = nome.search(/\s[-|–]\s|,\s|\s\(/);
  if (corte > 15) nome = nome.substring(0, corte).trim();
  if (nome.length > CONFIG.TAMANHO_MAX_NOME) {
    nome = nome.substring(0, CONFIG.TAMANHO_MAX_NOME);
    nome = nome.substring(0, nome.lastIndexOf(' ')).trim();
  }
  return nome.replace(/\s+(com|de|da|do|para|e|sem|em|p\/|-)$/i, '').trim();
}

function brl(n) {
  return 'R$ ' + Number(n).toLocaleString('pt-BR', {
    minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function linkAfiliado(url) {
  const params = `matt_word=${encodeURIComponent(CONFIG.MATT_WORD)}&matt_tool=${encodeURIComponent(CONFIG.MATT_TOOL)}`;
  return url + (url.includes('?') ? '&' : '?') + params;
}

function legenda(p) {
  const linhas = [`🔥 <b>${html(nomeCurto(p.nome))}</b>`, ''];
  if (p.tipo === 'promocao' && p.preco_anterior) {
    linhas.push(`✅ <s>De ${brl(p.preco_anterior)}</s> → <b>Por ${brl(p.preco)}</b>`);
    linhas.push(`🔻 ${p.desconto}% OFF`);
  } else {
    linhas.push(`✅ <b>Por ${brl(p.preco)}</b>`);
  }
  const link = linkAfiliado(p.url).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  linhas.push(`🛒 <a href="${link}">Comprar no Mercado Livre</a>`);
  return linhas.join('\n');
}

// ---------------- 5. TELEGRAM ----------------
async function telegram(metodo, corpo) {
  const r = await fetch(`${ENV.TG_API}/bot${ENV.TG_TOKEN}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.description || ('HTTP ' + r.status));
  return d;
}

async function postar(p) {
  const caption = legenda(p);
  try {
    await telegram('sendPhoto', { chat_id: ENV.TG_CHAT, photo: p.imagem, caption, parse_mode: 'HTML' });
  } catch (e) {
    console.log(`  foto recusada (${e.message}); enviando só texto`);
    await telegram('sendMessage', { chat_id: ENV.TG_CHAT, text: caption, parse_mode: 'HTML' });
  }
}

// ---------------- PRINCIPAL ----------------
(async () => {
  const faltando = ['ML_CLIENT_SECRET', 'ESTADO_SENHA']
    .concat(ENV.TESTE ? [] : ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'])
    .filter(n => !process.env[n]);
  if (faltando.length) falhar('Faltam os secrets: ' + faltando.join(', '));
  mascarar(ENV.CLIENT_SECRET);

  const estado = lerEstado() || {};
  if (!estado.postados || typeof estado.postados !== 'object') estado.postados = {};
  for (const id of Object.keys(estado.postados)) {
    if (agora - (estado.postados[id].data || 0) > CONFIG.DIAS_DE_HISTORICO * DIA) delete estado.postados[id];
  }

  const token = await obterToken(estado);
  const produtos = await buscar(token, estado);
  const escolhidos = selecionar(produtos, estado);
  console.log(`${produtos.length} produtos válidos, ${escolhidos.length} escolhidos.`);

  let enviados = 0;
  for (const p of escolhidos) {
    const resumo = `${p.tipo === 'promocao' ? p.desconto + '% OFF' : 'preço ótimo'} | ${brl(p.preco)} | ${nomeCurto(p.nome)} (${p.id})`;
    if (ENV.TESTE) {
      console.log('[TESTE, não postado] ' + resumo);
      continue;
    }
    try {
      await postar(p);
      estado.postados[p.id] = { data: agora, preco: p.preco, nome: nomeCurto(p.nome).toLowerCase() };
      enviados++;
      console.log('Postado: ' + resumo);
    } catch (e) {
      console.log(`::warning::Falhou no Telegram: ${e.message} | ${resumo}`);
    }
    await new Promise(res => setTimeout(res, 1500));
  }

  estado.ultima_execucao = new Date(agora).toISOString();
  salvarEstado(estado);
  console.log(`Fim: ${enviados} post(s) enviados. Histórico: ${Object.keys(estado.postados).length} produtos.`);
})().catch(e => falhar('Erro inesperado: ' + (e && e.message)));
