// =====================================================================
// ACHADOS TECH - Ofertas do Mercado Livre -> Telegram (GitHub Actions)
// =====================================================================
// Roda a cada 20 min pelo GitHub Actions (.github/workflows/ofertas.yml).
// Faz o mesmo que o workflow do n8n:
//   1. Renova o acesso à API do Mercado Livre (refresh_token rotativo)
//   2. Busca os mais vendidos: placas de vídeo + 1 componente + 1 periférico
//   3. Escolhe as ofertas (1 placa de vídeo a cada 3 posts, promoções primeiro)
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
  PLACA_A_CADA: 3,           // 1 placa de vídeo a cada N posts enviados
  DESCONTO_MINIMO: 10,       // % mínimo para contar como promoção
  LIMITE_POSTS: 2,           // posts por execução
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
  { id: 'MLB1664', nome: 'Headsets', exigir: /gamer|headset/i },
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
  CODIGO_AUTORIZACAO: (process.env.ML_AUTH_CODE || '').trim(),
  REDIRECT_URI: process.env.ML_REDIRECT_URI || 'https://example.com/callback',
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
// Diagnóstico: conta os status HTTP por tipo de endpoint (aparece no log)
const DIAG = {};
function anotar(url, status, corpo) {
  const tipo = url.replace(ENV.API, '').replace(/MLB\w+/g, '{id}').split('?')[0];
  DIAG[tipo] = DIAG[tipo] || { contagem: {}, exemplo: null };
  DIAG[tipo].contagem[status] = (DIAG[tipo].contagem[status] || 0) + 1;
  if (status !== 200 && !DIAG[tipo].exemplo && corpo) DIAG[tipo].exemplo = String(corpo).slice(0, 160);
}

async function getJson(url, token) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, accept: 'application/json' },
        signal: AbortSignal.timeout(15000)
      });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) {
        anotar(url, r.status, await r.text().catch(() => ''));
        return null;
      }
      anotar(url, 200);
      return await r.json();
    } catch (e) {
      if (tentativa === 2) { anotar(url, String(e.message || 'erro')); return null; }
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

// Reautorização: se o secret ML_AUTH_CODE tiver um código novo (TG-...), troca por token
async function trocarCodigo(estado) {
  const codigo = ENV.CODIGO_AUTORIZACAO;
  if (!codigo) return;
  const marca = crypto.createHash('sha256').update(codigo).digest('hex').slice(0, 16);
  if (estado.codigo_usado === marca) return;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ENV.CLIENT_ID,
    client_secret: ENV.CLIENT_SECRET,
    code: codigo,
    redirect_uri: ENV.REDIRECT_URI
  });
  const r = await fetch(ENV.API + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20000)
  });
  const d = await r.json().catch(() => ({}));
  estado.codigo_usado = marca;
  if (!r.ok || !d.access_token) {
    console.log(`::warning::O código de autorização (ML_AUTH_CODE) não funcionou: HTTP ${r.status} ${d.message || d.error || ''}. ` +
      'Ele vale só 10 minutos e só pode ser usado 1 vez: gere outro.');
    return;
  }
  mascarar(d.access_token);
  mascarar(d.refresh_token);
  estado.access_token = d.access_token;
  estado.refresh_token = d.refresh_token;
  estado.expira_em = agora + (Number(d.expires_in) || 21600) * 1000;
  salvarEstado(estado);
  console.log('Acesso ao Mercado Livre reautorizado com o código novo.');
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
    if (!p) return null;
    if (ENV.TESTE && !DIAG._ficha) {
      DIAG._ficha = { campos: Object.keys(p), buy_box_winner: p.buy_box_winner || null,
        preco: p.price ?? null, status: p.status ?? null };
      for (const extra of [`/products/${c.id}/items?limit=1&status=active`, `/products/${c.id}/price`, `/products/${c.id}/buy_box_winner`]) {
        await getJson(ENV.API + extra, token);
      }
    }
    let novos = (itens?.results || []).filter(x => x.condition === 'new' && Number(x.price) > 0);
    // Plano B: oferta vencedora que vem na própria ficha do produto
    const bb = p.buy_box_winner;
    if (!novos.length && bb && Number(bb.price) > 0 && (!bb.condition || bb.condition === 'new')) novos = [bb];
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
      if (cat.exigir && !cat.exigir.test(p.nome)) continue;
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
  // Filas: promoções primeiro (maior desconto), depois "preço ótimo"
  const gpus = [...promocoes.filter(p => p.gpu).map(p => ({ ...p, tipo: 'promocao' })),
                ...reservas.filter(p => p.gpu).map(p => ({ ...p, tipo: 'preco_otimo' }))];
  const outros = [...promocoes.filter(p => !p.gpu).map(p => ({ ...p, tipo: 'promocao' })),
                  ...reservas.filter(p => !p.gpu).map(p => ({ ...p, tipo: 'preco_otimo' }))];

  // A cada PLACA_A_CADA posts enviados, 1 é placa de vídeo (se houver uma nova)
  let desdeGpu = Number(estado.posts_desde_placa) || 0;
  const escolhidos = [];
  while (escolhidos.length < CONFIG.LIMITE_POSTS && (gpus.length || outros.length)) {
    const vezDaPlaca = desdeGpu >= CONFIG.PLACA_A_CADA - 1;
    const p = (vezDaPlaca && gpus.length) || !outros.length ? gpus.shift() : outros.shift();
    escolhidos.push(p);
    desdeGpu = p.gpu ? 0 : desdeGpu + 1;
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

  await trocarCodigo(estado);
  const token = await obterToken(estado);
  const produtos = await buscar(token, estado);
  const escolhidos = selecionar(produtos, estado);
  console.log(`${produtos.length} produtos válidos, ${escolhidos.length} escolhidos.`);
  if (!produtos.length || ENV.TESTE) console.log('Diagnóstico da API: ' + JSON.stringify(DIAG));
  if (ENV.TESTE && process.env.SONDAR === '1') {
    const sondas = [
      ENV.API + '/sites/MLB/search?q=placa%20de%20video&limit=2',
      ENV.API + '/sites/MLB/search?category=MLB1658&limit=2',
      ENV.API + '/products/search?status=active&site_id=MLB&q=rtx%205060',
      'https://www.mercadolivre.com.br/ofertas',
      'https://lista.mercadolivre.com.br/placa-de-video'
    ];
    for (const u of sondas) {
      try {
        const r = await fetch(u, { headers: u.startsWith(ENV.API) ? { Authorization: 'Bearer ' + token } :
          { 'accept-language': 'pt-BR' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        const t = await r.text();
        console.log(`SONDA ${r.status} ${u.replace(ENV.API, '')} tam=${t.length} loc=${r.headers.get('location') || ''} ` +
          `precos=${(t.match(/andes-money-amount__fraction/g) || []).length} cards=${(t.match(/poly-card/g) || []).length} ` +
          `inicio=${t.slice(0, 120).replace(/\s+/g, ' ')}`);
      } catch (e) { console.log('SONDA erro ' + u + ' ' + e.message); }
    }
  }

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
      estado.posts_desde_placa = p.gpu ? 0 : (Number(estado.posts_desde_placa) || 0) + 1;
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
