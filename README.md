# Google Workspace Gateway

Aplikacja pośredniczy między zaufanym agentem a Google Calendar i Google Tasks. Użytkownik loguje się przez Google, wybiera własny kalendarz lub listę zadań, a agent komunikuje się z gatewayem przez wewnętrzne REST API. Gateway obsługuje OAuth, bezpieczne przechowywanie refresh tokenów i wywołania Google API.

Projekt powstał dla monitora [Cracow](https://github.com/sigmalko/Cracow). Ten gateway nie publikuje wydarzeń samodzielnie ani nie weryfikuje ich źródeł. Agent ma wysyłać wyłącznie zweryfikowane dane.

## Interfejs webowy i przekierowanie OAuth

Aplikacja ma prosty panel HTML do logowania i zarządzania połączeniami. Otwarcie strony głównej (`https://twoja-domena/twoja-sciezka/`) **nie** przekierowuje automatycznie do Google: pokazuje przycisk „Zaloguj się przez Google”. Dopiero jego kliknięcie rozpoczyna OAuth. Po zalogowaniu użytkownik może osobno przyznać zakresy Calendar i Tasks, wybrać kalendarz/listę, wyłączyć publikację lub lokalnie odłączyć konto. Panel nie jest API dla agenta.

Google kieruje przeglądarkę na skonfigurowany `OAUTH_REDIRECT_URL`, np. `https://calendar.example.org/google-workspace/oauth/google/callback`. Zewnętrzny reverse proxy/gateway użytkownika musi skierować ten publiczny URL do serwisu HTTP tej aplikacji. Może przekazać ścieżkę bez zmian albo usunąć z niej prefiks przed przekazaniem; aplikacja obsługuje oba warianty. W Google Cloud należy wpisać identyczny URL w dozwolonych URI przekierowania.

## Wymagania

- VPS z Docker Engine i Docker Compose.
- Google Cloud project, Google OAuth client typu **Web application**, włączone Google Calendar API i Google Tasks API.
- Publiczny HTTPS URL callbacku obsługiwany przez Twój zewnętrzny reverse proxy/gateway. Ten projekt nie zarządza domeną, TLS, certyfikatami, firewallem ani reverse proxy.
- Node.js 24+ tylko do uruchamiania/testów bez Dockera.

## Konfiguracja Google OAuth

1. W [Google Cloud Console](https://console.cloud.google.com/) utwórz projekt lub wybierz istniejący.
2. W **APIs & Services → Library** włącz **Google Calendar API** i **Google Tasks API**.
3. W **Google Auth Platform → Branding** ustaw nazwę aplikacji, adres wsparcia i kontakt. W **Audience** wybierz **Internal** dla kont z jednej organizacji Workspace lub **External** dla użytkowników spoza organizacji. W trybie External + Testing dodaj konta do **Test users**. Ogranicz użytkowników gatewaya również przez `ALLOWED_EMAILS`.
4. W **Google Auth Platform → Data Access** dodaj wymagane zakresy:
   - logowanie: `openid`, `email`;
   - Calendar: `https://www.googleapis.com/auth/calendar.events.owned` i `https://www.googleapis.com/auth/calendar.calendarlist.readonly`;
   - Tasks: `https://www.googleapis.com/auth/tasks`.

   Calendar pokazuje tylko kalendarze, których użytkownik jest właścicielem. Zakresy OAuth nadają aplikacji szerszy dostęp niż pojedynczy wybrany cel; gateway ogranicza publikowanie do celu wskazanego przez użytkownika. Szczegóły: [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [Tasks scopes](https://developers.google.com/workspace/tasks/auth).
5. W **Google Auth Platform → Clients → Create Client** utwórz klienta typu **Web application**. W **Authorized redirect URIs** wklej dokładnie wartość, której użyjesz w `OAUTH_REDIRECT_URL`, np. `https://calendar.example.org/google-workspace/oauth/google/callback`. Zapisz `Client ID` oraz `Client secret`. Nie dodawaj gwiazdek ani nie pomijaj prefiksu ścieżki.
6. Przy publikacji OAuth na zewnątrz Google może wymagać weryfikacji aplikacji i domeny. W trybie External + Testing refresh token dla tych zakresów zwykle wygasa po 7 dniach. Administrator Workspace może także ograniczyć aplikacje OAuth.

## Instalacja i uruchomienie

```sh
git clone https://github.com/sigmalko/google-workspace-gateway.git
cd google-workspace-gateway
cp .env.example .env
```

Edytuj `.env`:

- `OAUTH_REDIRECT_URL` — pełny, publiczny callback HTTPS z dokładną ścieżką, którą zarejestrujesz w Google. Prefiks może być dowolny, np. `/google-workspace`; sama aplikacja wymaga końcówki `/oauth/google/callback`.
- `GOOGLE_CLIENT_ID` — Client ID z Google Cloud.
- `ALLOWED_EMAILS` — dozwolone adresy e-mail oddzielone przecinkami, np. `ALLOWED_EMAILS=anna@example.com,jan@example.com`. Spacje wokół adresów są usuwane, a wielkość liter nie ma znaczenia. Konta muszą też spełniać ustawienia Audience/Test users.
- `BIND_ADDRESS` i `GATEWAY_PORT` — adres interfejsu hosta i port hosta, na którym ma być dostępne HTTP. Domyślnie `127.0.0.1:8765`, czyli dostęp tylko z tego VPS. `PORT=8765` wewnątrz kontenera jest stały.

Utwórz sekrety poza repozytorium. Nie wpisuj ich w poleceniach powłoki, repozytorium ani logach:

```sh
umask 077
mkdir -p secrets
openssl rand -base64 32 > secrets/encryption_key
openssl rand -hex 32 > secrets/agent_token
```

W edytorze utwórz `secrets/google_client_secret` i wklej sam Client secret. Sekrety powinny być czytelne dla użytkownika kontenera (`1000:1000`) i niedostępne dla innych użytkowników hosta. `agent_token` to osobny sekret dla agenta, nie Google token.

Jeśli uruchamiasz checkout ze źródeł, zbuduj obraz lokalnie. Przy instalacji z release plik `.env.example` wskazuje już wersjonowany obraz w registry i ten krok pomiń.

```sh
docker build -t google-workspace-gateway:local .
```

Uruchom jedyny plik Compose:

```sh
docker compose up -d
docker compose ps
```

Aplikacja nasłuchuje HTTP na porcie `8765` w kontenerze. Domyślnie Compose publikuje go na `127.0.0.1:8765` hosta, więc reverse proxy działający na tym samym VPS może łączyć się z `http://127.0.0.1:8765`. Jeśli proxy znajduje się na innym hoście/kontenerze, ustaw `BIND_ADDRESS` na osiągalny prywatny interfejs albo użyj prywatnej sieci i ogranicz firewall do proxy. Ruch do tego portu nie jest szyfrowany przez tę aplikację; nie wystawiaj go publicznie bezpośrednio do Internetu. Nie konfiguruj w proxy dostępu publicznego do `/internal/v1/*`.

W swoim reverse proxy skonfiguruj trasę publicznego callbacku i panelu do portu aplikacji. To proxy odpowiada za TLS, certyfikaty, domenę, ochronę przed nadużyciami i filtrowanie dostępu. Nie musi ono udostępniać API agentowi: agent na tym samym VPS powinien łączyć się do lokalnego portu HTTP. Jeżeli proxy przekazuje prefiks ścieżki, gateway go rozpozna; jeżeli go usuwa, gateway obsłuży ścieżki aplikacji od `/`.

Otwórz w przeglądarce publiczny adres panelu, np. `https://calendar.example.org/google-workspace/`. Zaloguj się, połącz Calendar i/lub Tasks, zaakceptuj zakresy oraz wybierz cel. Dostęp do panelu ma tylko konto Google z `ALLOWED_EMAILS`.

Baza SQLite jest przechowywana w wolumenie Dockera `gateway_data`. Refresh tokeny są szyfrowane kluczem z `secrets/encryption_key`; rób bezpieczne kopie bazy i tego klucza razem. Utrata klucza uniemożliwi odczyt tokenów. Jedna instancja aplikacji powinna używać jednej bazy; odświeżanie tokenów nie jest synchronizowane pomiędzy replikami.

## Obraz i release na GitHubie

GitHub Actions uruchamia testy dla pull requestów, pushy na `main` i tagów `v*`. Po udanych testach push na `main` publikuje obraz `ghcr.io/sigmalko/google-workspace-gateway:latest` oraz tag `sha-<pełny SHA>` dla `linux/amd64` i `linux/arm64`. Tag `vMAJOR.MINOR.PATCH` musi wskazywać commit z historii `main`; publikuje obraz z tagiem bez `v` oraz tworzy GitHub Release. Workflow można także uruchomić ręcznie z karty Actions na gałęzi `main`.

Obraz zawiera etykiety OCI opisujące projekt, jego źródła, dokumentację, wydawcę, wersję i commit. Przy budowaniu lokalnym wersja to `dev`, a commit `unknown`, chyba że podasz argumenty `IMAGE_VERSION` i `IMAGE_REVISION`; GitHub Actions ustawia je automatycznie i dodaje datę utworzenia.

Aby wydać wersję, wypchnij nowy tag, np. `git tag v0.1.0` i `git push origin v0.1.0`. Release zawiera opis instalacji oraz trzy pliki: `docker-compose.yml`, `env.example` (GitHub usuwa początkową kropkę z nazw assetów) i `README.md`. W `env.example` jest ustawiony obraz przypięty do danej wersji. Pobierz te pliki z konkretnego release, zmień nazwę `env.example` na `.env` i skonfiguruj go oraz pliki sekretów według sekcji instalacji. Następnie uruchom `docker compose pull` i `docker compose up -d`. Jeśli pakiet GHCR jest prywatny, zaloguj Dockera do GHCR albo zmień widoczność pakietu; samo publiczne repozytorium nie gwarantuje publicznej widoczności obrazu.

## Alternatywny pipeline GitLab

Repozytorium źródłowe jest na GitHubie. Plik `.gitlab-ci.yml` uruchomi się dopiero po zaimportowaniu repozytorium do GitLaba lub skonfigurowaniu projektu/mirrora GitLab, który uruchamia pipeline dla commitów i tagów. W GitLab włącz Container Registry i Package Registry. Pipeline wymaga runnera Docker-in-Docker z obsługą TLS oraz trybem `privileged`; tokeny registry i CI `CI_JOB_TOKEN` są używane automatycznie, nie dodawaj własnego tokenu do zmiennych. Przy DinD runner musi współdzielić katalog certyfikatów klienta `/certs/client` z jobem.

Każdy commit na domyślnej gałęzi buduje obraz `linux/amd64` i publikuje go pod tagami `latest` oraz `sha-<commit>`. Tag wersji `vMAJOR.MINOR.PATCH` buduje obraz pod wersją bez `v` i pod tagiem SHA, a po powodzeniu tworzy GitLab Release. Opis release zawiera instrukcję z `README.md`; assety to gotowy `docker-compose.yml` i `.env.example` z przypiętym obrazem dla tej wersji. Wzorzec jest podobny do flow w [agents-in-docker-with-dind](https://github.com/sigmalko/agents-in-docker-with-dind): publikacja `latest` z gałęzi głównej oraz wersjonowany obraz i release assety z tagu.

W GitLabie utwórz i wypchnij tag wersji, np. `v0.1.0`, na commit domyślnej gałęzi. Z Release pobierz trzy assety. Skopiuj `.env.example` do `.env`, ustaw callback, Client ID, allowlistę oraz sekrety opisane wyżej; sprawdź, że `GATEWAY_IMAGE` wskazuje wersję z release. Następnie uruchom `docker compose pull` i `docker compose up -d`. Jeśli Container Registry projektu nie pozwala na anonimowe pobieranie, zaloguj hosta Docker do GitLab Registry przed `docker compose pull`. Nie dodawaj pliku `.env` ani sekretów do Gita.

## Kontrakt integracji z agentem Cracow

Cracow nie loguje się do Google i nie dostaje Google access ani refresh tokenów. Użytkownik przechodzi OAuth w panelu gatewaya, a Cracow używa wyłącznie `agent_token` do wewnętrznego API. Token uprawnia do wszystkich aktywnych subskrypcji; chroń go jak hasło i nie udostępniaj klasyfikatorowi/modelowi.

Dla agenta działającego na tym samym VPS konfiguracja `.codex/state/config.json` w repo Cracow ma postać:

```json
{
  "delivery": "google",
  "gateway": {
    "url": "http://127.0.0.1:8765",
    "tokenFile": "/pełna/ścieżka/do/google-workspace-gateway/secrets/agent_token",
    "instance": "moj-gateway",
    "calendarDurationMinutes": 90
  }
}
```

Plik musi być dostępny tylko dla użytkownika uruchamiającego agenta. `instance` jest stabilną nazwą instalacji; nie zmieniaj jej przy zwykłym restarcie. `calendarDurationMinutes` (1–1440) jest potrzebne dla Calendar, ponieważ monitor nie ma potwierdzonego czasu końca. Agent dopuszcza HTTPS albo HTTP wyłącznie na loopback, bez ścieżki w `url`.

Każde żądanie API wymaga nagłówka `Authorization: Bearer <agent_token>`. Agent powinien czytać token z pliku, nie przekazywać go w argumentach procesu i nie logować nagłówków.

### `GET /internal/v1/subscriptions`

Zwraca włączone cele dla połączonych, dozwolonych kont; nie ujawnia adresów e-mail ani tokenów:

```json
{"subscriptions":[{"id":"subscription-id","kind":"calendar"},{"id":"another-id","kind":"tasks"}]}
```

Agent publikuje do każdej zwróconej subskrypcji. Pusta lista oznacza, że użytkownik nie włączył celu.

### `POST /internal/v1/publications`

Wymaga `Content-Type: application/json` i nagłówka `Idempotency-Key` (agent Cracow używa stabilnego ID zweryfikowanego wydarzenia). Przykładowe ciało:

```json
{
  "subscriptionId": "subscription-id",
  "sourceEventId": "cracow:standup-pl:stable-event-id",
  "category": "stand-up",
  "title": "Nazwa występu",
  "start": "2027-03-12T19:00:00+01:00",
  "end": "2027-03-12T20:30:00+01:00",
  "timeZone": "Europe/Warsaw",
  "venue": "Kraków, sala",
  "sourceUrl": "https://example.org/wystep",
  "verifiedAt": "2027-01-10T12:00:00Z"
}
```

Wymagane pola: `subscriptionId`, `sourceEventId`, `title`, `start`, `timeZone`; Calendar wymaga też `end` późniejszego niż `start`. Czas musi być datą RFC 3339 z offsetem, strefa nazwą IANA. Dla Cracow należy przekazywać źródło oraz czas weryfikacji. Google Tasks przechowuje termin tylko jako datę, a godzinę wydarzenia gateway zapisuje w notatce.

Typowe odpowiedzi:

- `201 {"status":"created","id":"..."}` — utworzono wpis;
- `200 {"status":"already_exists","id":"..."}` — identyczne żądanie już obsłużono;
- `409` z `idempotency_conflict`, `source_already_recorded` lub `reauthorization_required` — nie ponawiać bez rozwiązania przyczyny;
- `409 {"status":"uncertain",...}` — sprawdź ręcznie stan w Google i uzgodnij go procedurą niżej;
- `400` — niepoprawne dane, `401` — niepoprawny token, `404` — brak/wyłączona subskrypcja, `503` — Google chwilowo niedostępne.

`--dry-run` w Cracow nie wywołuje endpointu publikacji. Gateway nie aktualizuje ani nie usuwa wcześniej utworzonych wpisów. Agent powinien zachowywać lokalny rejestr publikacji i nie ponawiać wyniku `uncertain` automatycznie.

### Uzgadnianie wyniku `uncertain`

Przy niejednoznacznej awarii gateway blokuje automatyczne ponowne wysłanie, aby ograniczyć duplikaty. Zatrzymaj monitor i sprawdź zdarzenie/zadanie na koncie Google. Następnie można sprawdzić wynik:

```sh
docker compose exec gateway node src/resolve.mjs SUBSCRIPTION_ID IDEMPOTENCY_KEY --inspect
```

Po potwierdzeniu poprawnego wpisu oznacz go jako utworzony:

```sh
docker compose exec gateway node src/resolve.mjs SUBSCRIPTION_ID IDEMPOTENCY_KEY --created GOOGLE_ID
```

Użyj `--retry` wyłącznie po ręcznym potwierdzeniu, że Google nie utworzył wpisu. Gdy nie można ustalić wyniku, nie ponawiaj publikacji.

## Wielu użytkowników i zakres dostępu

Wiele osób może korzystać z tej samej instancji, o ile ich adresy znajdują się w `ALLOWED_EMAILS` i dopuszcza je konfiguracja Google OAuth. Każda osoba loguje się własnym kontem, przechodzi zgodę OAuth i wybiera własny kalendarz/listę. Baza rozdziela tożsamości, sesje, zakresy, cele i zaszyfrowane refresh tokeny. Usunięcie osoby z allowlisty blokuje jej dostęp do API, ale administrator powinien także odłączyć jej konto w panelu i usunąć ją z konfiguracji Google, jeśli to potrzebne.

## Ograniczenia i kontrola

- Refresh token jest szyfrowany w spoczynku i używany tylko przez gateway do pobrania/odświeżenia krótkotrwałego access tokenu. Przy `invalid_grant` połączenie przechodzi w `reauthorization_required`; użytkownik musi ponownie przyznać zgodę.
- Użytkownik może lokalnie wyłączyć subskrypcję lub odłączyć konto; zgodę OAuth może cofnąć też w ustawieniach Google. Odłączenie nie usuwa wydarzeń ani zadań.
- Jeden `agent_token` ma dostęp do wszystkich włączonych subskrypcji; obecnie brak odrębnych kluczy i ACL per agent.
- Projekt nie został poddany niezależnemu audytowi bezpieczeństwa. Ogranicz dostęp sieciowy i uprawnienia do sekretów, wykonuj kopie zapasowe i monitoruj stan usługi.

## Kontrola lokalna

```sh
npm ci
npm test
npm audit --omit=dev
git diff --check
```

Testy używają lokalnego HTTP, bazy w pamięci i atrap Google. Nie logują się do Google ani nie tworzą wpisów.
