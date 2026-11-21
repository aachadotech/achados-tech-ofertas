# Achados Tech - Ofertas do Mercado Livre no Telegram

Bot que roda sozinho no GitHub Actions, a cada 20 minutos, sem precisar de PC ligado.

Em cada rodada ele:
1. renova o acesso à API do Mercado Livre;
2. olha os mais vendidos de 3 categorias (rodízio entre 32 de hardware, periféricos e setup);
3. escolhe até 3 ofertas que não foram postadas nos últimos 7 dias (promoções primeiro);
4. posta no canal do Telegram com o link de afiliado escondido em "Comprar no Mercado Livre".

## Secrets (Settings → Secrets and variables → Actions)

| Nome | O que é |
|---|---|
| `ML_CLIENT_SECRET` | Chave secreta do app no devcenter do Mercado Livre |
| `ML_REFRESH_TOKEN` | O refresh_token (TG-...) mais recente. Só é usado na primeira vez; depois o bot guarda os novos sozinho |
| `TELEGRAM_BOT_TOKEN` | Token do bot (pegue no @BotFather → /mybots → API Token) |
| `TELEGRAM_CHAT_ID` | ID do canal (Achados Tech: `-1004366739443`) |
| `ESTADO_SENHA` | Uma senha longa qualquer, inventada por você. Protege o arquivo de estado. **Não troque depois** |

Opcionais: `ML_CLIENT_ID`, `ML_MATT_WORD`, `ML_MATT_TOOL` (já vêm preenchidos no código).

## Como testar

Aba **Actions** → **Ofertas Mercado Livre** → **Run workflow**.
Com "Só testar" marcado, ele mostra no log o que postaria, sem postar.

## Onde fica o histórico

No branch `estado`, arquivo `estado.enc` (criptografado com `ESTADO_SENHA`).
Lá ficam o token do Mercado Livre, os produtos já postados e o rodízio de categorias.

## Se o acesso ao Mercado Livre cair

O log mostra "Não consegui renovar o acesso". Refaça a autorização do app, gere um refresh_token novo e
atualize o secret `ML_REFRESH_TOKEN`.

## Ajustes

No topo do `ofertas.js`, no bloco `CONFIG`: desconto mínimo, posts por rodada, dias sem repetir.
O intervalo fica em `.github/workflows/ofertas.yml` (`cron`).
