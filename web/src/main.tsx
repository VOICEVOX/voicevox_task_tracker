import { render } from "preact";

import {
  createPublicDetailsDto,
  createPublicNotificationHistoryDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicNotificationHistoryDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { App, DataLoadFailure } from "./app.js";
import { type PublicNotificationHistoryLoader } from "./notification-history-loader.js";

/** 公開summary DTOの取得に失敗したことを表す。 */
class PublicSummaryLoadError extends Error {}

/** 公開details DTOの取得に失敗したことを表す。 */
class PublicDetailsLoadError extends Error {}

async function loadPublicSummary(): Promise<PublicSummaryDto> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/summary.json`, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new PublicSummaryLoadError(
      `公開summary DTOを取得できません。HTTP statusは${response.status.toString()}です`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    throw new PublicSummaryLoadError("公開summary DTOをJSONとして解釈できません", {
      cause: error,
    });
  }
  return createPublicSummaryDto(value);
}

async function loadPublicDetails(): Promise<PublicDetailsDto> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/details.json`, {
    credentials: "omit",
  });
  if (!response.ok) {
    throw new PublicDetailsLoadError(
      `公開details DTOを取得できません。HTTP statusは${response.status.toString()}です`,
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch (error: unknown) {
    throw new PublicDetailsLoadError("公開details DTOをJSONとして解釈できません", {
      cause: error,
    });
  }
  return createPublicDetailsDto(value);
}

function createNotificationHistoryLoader(
  summary: PublicSummaryDto,
): PublicNotificationHistoryLoader {
  return async (): Promise<PublicNotificationHistoryDto> => {
    const response = await fetch(`${import.meta.env.BASE_URL}data/notification-history.json`, {
      credentials: "omit",
    });
    if (!response.ok) {
      throw new Error(
        `公開notification history DTOを取得できません。HTTP statusは${response.status.toString()}です`,
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error: unknown) {
      throw new Error("公開notification history DTOをJSONとして解釈できません", {
        cause: error,
      });
    }
    const history = createPublicNotificationHistoryDto(value);
    if (history.runId !== summary.runId || history.generatedAt !== summary.generatedAt) {
      throw new Error(
        "公開notification history DTOとsummary DTOのrun IDまたは生成時刻が一致しません",
      );
    }
    return history;
  };
}

const root = document.getElementById("app");
if (root == null) {
  throw new Error("Web UIの描画先がありません");
}

document.documentElement.lang = __VOICEVOX_TRACKER_LOCALE__;
document.title = __VOICEVOX_TRACKER_TITLE__;

void loadPublicSummary()
  .then((summary) => {
    render(
      <App
        basePath={import.meta.env.BASE_URL}
        locale={__VOICEVOX_TRACKER_LOCALE__}
        loadDetails={loadPublicDetails}
        loadNotificationHistory={createNotificationHistoryLoader(summary)}
        now={new Date()}
        summary={summary}
        title={__VOICEVOX_TRACKER_TITLE__}
      />,
      root,
    );
  })
  .catch((error: unknown) => {
    console.error("Web UIの公開データ読み込みに失敗しました", error);
    render(<DataLoadFailure />, root);
  });
