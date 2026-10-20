# letterbox-shuffle

Site que busca filmes no Letterboxd com filtros, sorteia um para você e mostra onde assistir.

- **Onde buscar:** listas públicas (Top 500, listas oficiais e populares), a sua rede (watchlists e filmes vistos de quem você segue e de quem te segue), ou as duas.
- **Filtros:** gênero, período de lançamento (por década **ou** por intervalo de anos), nota mínima e país de produção.
- **Resultado:** um filme sorteado em destaque e, abaixo, o ranking dos mais bem avaliados que combinam com os filtros. Clicar num filme do ranking coloca ele em destaque.
- **Onde assistir:** serviços de assinatura, grátis, aluguel e compra, segundo o JustWatch, na região escolhida.
- **Seu perfil (opcional):** obrigatório só para buscar na sua rede. Com ele, os filmes que você já viu ficam de fora.

## Como rodar

Requer Node.js 16 ou superior.

```bash
npm install
npm start
```

Abra http://localhost:3000.

## Publicação (GitHub Pages + Render)

O GitHub Pages só serve arquivos estáticos, então o site (`public/`) fica no Pages e o backend (`server.js`) roda no [Render](https://render.com):

1. **Render:** em *Dashboard → New → Blueprint*, conecte este repositório. O `render.yaml` cria o serviço `letterbox-shuffle` no plano gratuito, em `https://letterbox-shuffle.onrender.com`. Se o Render der outro endereço, atualize `public/config.js`.
2. **GitHub Pages:** publica a branch `main` direto da raiz (*Settings → Pages → Deploy from a branch*). O `index.html` da raiz redireciona para `public/`, e o `.nojekyll` faz o Pages servir os arquivos sem passar pelo Jekyll.

No plano gratuito, o Render desliga o servidor depois de uns 15 minutos sem uso. A primeira visita depois disso leva de 30 a 50 segundos a mais enquanto ele liga; o site avisa quando isso acontece.

## Como funciona

O Letterboxd não tem API pública, então o servidor lê as páginas públicas do site:

1. Junta os candidatos das fontes escolhidas. Nas listas públicas, prioriza as que combinam com os filtros (Top 250 de terror, por década, filmes brasileiros etc.). Na rede, lê as watchlists e os filmes vistos recentes de cada pessoa.
2. Descarta pelo ano, que já vem nas listas, e abre a página de até 400 filmes para conferir gênero, país e nota.
3. Com o seu perfil, confirma em `letterboxd.com/<você>/film/<filme>/` que você não registrou o filme.
4. Devolve até 30 filmes ordenados pela nota. O sorteio acontece no navegador, com mais chance para os mais bem avaliados.

A disponibilidade em streaming vem da API pública do JustWatch, a mesma fonte da seção "Where to watch" do Letterboxd. O filme é identificado pelo ID do TMDB.

O progresso chega ao navegador via Server-Sent Events, com um sinal a cada 10 segundos para o site saber que o servidor continua trabalhando. A busca tem limite de 90 segundos: passado isso, o servidor responde com o que já encontrou. Os dados ficam em cache por 30 minutos, então buscas parecidas são bem mais rápidas.

## Limitações

O Cloudflare do Letterboxd bloqueia algumas páginas para acessos automatizados (paginação de `/films/`, de seguidores e filtros de catálogo). Por isso:

- só a **primeira página** de seguindo/seguidores é lida (cerca de 25 pessoas de cada);
- dos filmes vistos de cada pessoa, só os **72 mais recentes** entram;
- as watchlists são lidas até **6 páginas** por pessoa;
- perfis e watchlists privados ficam de fora;
- as listas públicas cobrem alguns milhares de filmes, não o catálogo inteiro.
