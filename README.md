# letterbox-shuffle

Site que recebe um perfil do Letterboxd e um gênero e sorteia um filme desse gênero que você **ainda não viu**, tirado das watchlists e dos filmes vistos de quem você segue e de quem te segue.

## Como rodar

Requer Node.js 16 ou superior.

```bash
npm install
npm start
```

Abra http://localhost:3000, digite seu usuário (ou a URL do perfil), escolha um gênero e clique em **Sortear filme**.

## Como funciona

O Letterboxd não tem API pública, então o servidor lê as páginas públicas do site:

1. Lê os seus filmes vistos recentes e a sua rede (seguindo e seguidores).
2. Reúne as watchlists e os filmes vistos recentes de cada pessoa da rede.
3. Embaralha os candidatos. Filmes que aparecem nas listas de mais pessoas têm mais chance de sair.
4. Verifica o gênero de cada candidato e confirma em `letterboxd.com/<você>/film/<filme>/` que você não registrou o filme.

O progresso é enviado ao navegador via Server-Sent Events. As respostas ficam em cache por 30 minutos, então "Sortear outro" é quase instantâneo.

## Limitações

O Cloudflare do Letterboxd bloqueia algumas páginas para acessos automatizados (paginação de `/films/`, de seguidores e filtros por gênero). Por isso:

- só a **primeira página** de seguindo/seguidores é lida (cerca de 25 pessoas de cada);
- dos filmes vistos de cada pessoa, só os **72 mais recentes** entram;
- as watchlists são lidas até **6 páginas** por pessoa;
- perfis e watchlists privados ficam de fora.
